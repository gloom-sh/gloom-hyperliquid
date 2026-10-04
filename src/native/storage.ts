import { mkdir, readFile, writeFile, rename, unlink, chmod, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Address, Network, TradingStatus } from '../trading/types';

interface StoredProfile {
  version:1; mode:TradingStatus['mode']; address?:Address; agentAddress?:Address;
  expiresAt?:number; agentName?:string; storage?:'keychain'|'file'; riskAcknowledged?:boolean; eligibleAcknowledged?:boolean;
}
/** Never returns the private key through the public service interface. */
export class KeyStore {
  readonly directory:string;
  private service:string;
  constructor(dataDir:string,network:Network) {
    this.directory=join(dataDir,network);this.service=`gloom-hyperliquid-${network}-${createHash('sha256').update(dataDir).digest('hex').slice(0,20)}`;
  }
  private async ensure() {
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const stat=await lstat(this.directory);if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('Credential directory must be a real directory.');
    await chmod(this.directory,0o700);
  }
  async readProfile():Promise<StoredProfile> {
    try{return JSON.parse(await readFile(join(this.directory,'profile.json'),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('Could not read wallet profile.');return {version:1,mode:'disconnected'};}
  }
  async writeJson(name:string,value:unknown) {
    if(!/^[a-z0-9-]+\.json$/.test(name))throw new Error('Invalid storage name.');
    await this.ensure();const target=join(this.directory,name),temporary=`${target}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary,JSON.stringify(value),{mode:0o600,flag:'wx'});await rename(temporary,target);await chmod(target,0o600);
  }
  async writeProfile(value:StoredProfile) { await this.writeJson('profile.json',value); }
  async saveKey(key:`0x${string}`):Promise<'keychain'|'file'> {
    await this.ensure();
    try {await Bun.secrets.set({service:this.service,name:'api-wallet',value:key});await unlink(join(this.directory,'api-wallet.key')).catch(()=>{});return 'keychain';}
    catch {if((await this.readProfile()).storage==='keychain')throw new Error('Unlock the OS keychain before replacing its API wallet.');const temporary=join(this.directory,`.key-${crypto.randomUUID()}`);await writeFile(temporary,key,{mode:0o600,flag:'wx'});await rename(temporary,join(this.directory,'api-wallet.key'));return 'file';}
  }
  async readKey(storage:'keychain'|'file'):Promise<`0x${string}`> {
    let key:string|null;
    try {if(storage==='keychain')key=await Bun.secrets.get({service:this.service,name:'api-wallet'});else {const file=join(this.directory,'api-wallet.key');const stat=await lstat(file);if(stat.isSymbolicLink()||!stat.isFile()||(stat.mode&0o077)!==0)throw new Error();key=await readFile(file,'utf8');}}catch{throw new Error('API wallet key is unavailable or has unsafe permissions. Reconnect the wallet.');}
    if(!key||!/^0x[0-9a-fA-F]{64}$/.test(key))throw new Error('API wallet key is unavailable. Reconnect the wallet.');return key as `0x${string}`;
  }
  async disconnect() {const profile=await this.readProfile();if(profile.storage==='keychain'){try{await Bun.secrets.delete({service:this.service,name:'api-wallet'});if(await Bun.secrets.get({service:this.service,name:'api-wallet'}))throw new Error();}catch{throw new Error('Could not remove the API wallet from the OS keychain. Disconnect was not completed.');}}await unlink(join(this.directory,'api-wallet.key')).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('Could not remove the API wallet file. Disconnect was not completed.');});await this.writeProfile({version:1,mode:'disconnected'});}
  async readJson<T>(name:string,fallback:T):Promise<T> {try{return JSON.parse(await readFile(join(this.directory,name),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return fallback;throw new Error('Could not read local trading state.');}}
  async acquireTwapLease(id:string):Promise<()=>Promise<void>>{
    await this.ensure();const name=createHash('sha256').update(id).digest('hex').slice(0,32),lock=join(this.directory,`twap-${name}.lock`);
    try{await mkdir(lock,{mode:0o700});}catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      const recovery=`${lock}.recovery`;try{await mkdir(recovery,{mode:0o700});}catch{throw new Error('Another process is inspecting the local TWAP lock.');}
      try{
        let owner:{pid:number};try{owner=JSON.parse(await readFile(join(lock,'owner.json'),'utf8'));}catch{throw new Error('Local TWAP lock is incomplete. Inspect the running process before retrying.');}
        if(!Number.isSafeInteger(owner.pid)||owner.pid<=0)throw new Error('Local TWAP lock owner is invalid.');
        try{process.kill(owner.pid,0);throw new Error('This local TWAP is running in another Gloom process.');}catch(check){if((check as NodeJS.ErrnoException).code!=='ESRCH')throw check;}
        await rm(lock,{recursive:true});await mkdir(lock,{mode:0o700});
      }finally{await rm(recovery,{recursive:true});}
    }
    const token=crypto.randomUUID();await writeFile(join(lock,'owner.json'),JSON.stringify({pid:process.pid,token}),{mode:0o600,flag:'wx'});
    return async()=>{const owner=JSON.parse(await readFile(join(lock,'owner.json'),'utf8'));if(owner.token!==token)throw new Error('Local TWAP lock changed owner.');await rm(lock,{recursive:true});};
  }
  async tradingLock<T>(work:()=>Promise<T>):Promise<T>{await this.ensure();const lock=join(this.directory,'trading.lock');try{await mkdir(lock,{mode:0o700});}catch{throw new Error('Another trading request is in progress. Wait for its outcome.');}try{return await work();}finally{await import('node:fs/promises').then(fs=>fs.rmdir(lock));}}
  /** Persist before signing; file lock serializes multiple app processes sharing one profile. */
  async nextNonce():Promise<number> {
    await this.ensure();const lock=join(this.directory,'nonce.lock');const deadline=Date.now()+5000;
    for(;;){try{await mkdir(lock,{mode:0o700});break;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||Date.now()>deadline)throw new Error('Another trading process holds the nonce lock.');await new Promise(resolve=>setTimeout(resolve,30));}}
    try {const previous=await this.readJson<number>('nonce.json',0);const next=Math.max(Date.now(),previous+1);await this.writeJson('nonce.json',next);return next;}finally{await import('node:fs/promises').then(fs=>fs.rmdir(lock));}
  }
}

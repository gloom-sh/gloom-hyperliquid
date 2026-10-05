import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import {
  Box,
  Text,
  TextAttributes,
  useUiCapabilities,
  type BoxRenderable,
  type InputRenderable,
} from "gloomberb/ui";
import {
  ChoiceDialog,
  KeyValueRow,
  MenuPopover,
  NumberField,
  SegmentedControl,
} from "gloomberb/components";
import { useDialog } from "gloomberb/dialog";
import { useShortcut } from "gloomberb/react";
import { blendHex, colors } from "gloomberb/theme";

// Order-entry controls the kit has no shape for: a side toggle and an action
// button that take the side's colour, an amount field that updates the order
// as it is typed, and the leverage track. Every one of them works by mouse and
// takes its keys from the ticket's field ring.

const RADIUS = 6;
const hairline = () => blendHex(colors.border, colors.borderFocused, 0.18);

export type Side = "buy" | "sell";
export const sideColor = (side: Side) =>
  side === "buy" ? colors.positive : colors.negative;

/** Buy / Long and Sell / Short as two halves; the chosen half fills with its side's colour. */
export function SideToggle({
  value,
  onChange,
  focused,
  width,
}: {
  value: Side;
  onChange: (side: Side) => void;
  focused: boolean;
  width: number;
}) {
  const native = useUiCapabilities().nativePaneChrome;
  useShortcut(
    (event) => {
      if (event.name !== "left" && event.name !== "right") return;
      event.preventDefault();
      event.stopPropagation();
      onChange(event.name === "left" ? "buy" : "sell");
    },
    { enabled: focused, scope: "hyperliquid-side", phase: "before" },
  );
  const half = (side: Side, label: string) => {
    const active = side === value;
    return (
      <Box
        key={side}
        flexGrow={1}
        flexBasis={0}
        height={native ? undefined : 1}
        alignItems="center"
        justifyContent="center"
        backgroundColor={
          active
            ? sideColor(side)
            : native
              ? undefined
              : focused
                ? colors.selected
                : colors.panel
        }
        hoverBackgroundColor={
          native && !active
            ? blendHex(colors.bg, colors.textBright, 0.06)
            : undefined
        }
        cursor="pointer"
        role="radio"
        aria-checked={active}
        data-gloom-interactive="true"
        onMouseDown={() => onChange(side)}
        style={
          native
            ? { borderRadius: RADIUS - 2, alignSelf: "stretch" }
            : undefined
        }
      >
        <Text
          fg={active ? colors.bg : focused ? colors.text : colors.textDim}
          attributes={active ? TextAttributes.BOLD : 0}
        >
          {label}
        </Text>
      </Box>
    );
  };
  return (
    <Box
      flexDirection="row"
      width={width}
      height={native ? 2 : 1}
      flexShrink={0}
      role="radiogroup"
      aria-label="Side"
      style={
        native
          ? {
              border: `1px solid ${focused ? colors.borderFocused : hairline()}`,
              borderRadius: RADIUS,
              padding: 2,
              gap: 2,
              boxSizing: "border-box",
            }
          : undefined
      }
    >
      {half("buy", "Buy / Long")}
      {half("sell", "Sell / Short")}
    </Box>
  );
}

/**
 * The ticket's one action, as wide as the ticket. It names what it will do in
 * the side's colour, and when it cannot act it says why instead.
 */
export function ActionButton({
  label,
  tone,
  disabled = false,
  active = false,
  onPress,
  width,
}: {
  label: string;
  tone: Side | "neutral";
  disabled?: boolean;
  active?: boolean;
  onPress: () => void;
  width: number;
}) {
  const native = useUiCapabilities().nativePaneChrome;
  const fill = tone === "neutral" ? colors.borderFocused : sideColor(tone);
  return (
    <Box
      width={width}
      height={native ? 2 : 1}
      flexShrink={0}
      alignItems="center"
      justifyContent="center"
      backgroundColor={disabled ? colors.panel : fill}
      cursor={disabled ? "default" : "pointer"}
      role="button"
      aria-label={label}
      aria-disabled={disabled || undefined}
      data-gloom-interactive={disabled ? undefined : "true"}
      onMouseDown={() => {
        if (!disabled) onPress();
      }}
      style={
        native
          ? {
              borderRadius: RADIUS,
              border: `1px solid ${disabled ? hairline() : fill}`,
              boxSizing: "border-box",
              boxShadow: active
                ? `0 0 0 2px ${colors.borderFocused}`
                : undefined,
            }
          : undefined
      }
    >
      <Text
        fg={disabled ? colors.textDim : colors.bg}
        attributes={
          (disabled ? 0 : TextAttributes.BOLD) |
          (active && !native ? TextAttributes.UNDERLINE : 0)
        }
      >
        {label}
      </Text>
    </Box>
  );
}

/**
 * A labelled number input whose value reaches the order on every keystroke.
 * Out of focus it shows the formatted value; in focus, the plain number.
 */
export function AmountField({
  label,
  value,
  display,
  placeholder = "--",
  active,
  focused,
  onActivate,
  onValue,
  width,
  labelWidth,
  inputWidth,
  trailing,
  fieldRef,
}: {
  label: string;
  value: number;
  /** The value as the ticket shows it; empty shows the placeholder. */
  display: string;
  placeholder?: string;
  active: boolean;
  focused: boolean;
  onActivate: () => void;
  onValue: (value: number) => void;
  width: number;
  labelWidth: number;
  inputWidth?: number;
  /** Beside the input: a unit, a unit switch or what the value works out to. */
  trailing?: ReactNode;
  fieldRef?: (node: BoxRenderable | null) => void;
}) {
  const native = useUiCapabilities().nativePaneChrome;
  const input = useRef<InputRenderable | null>(null);
  const [draft, setDraft] = useState(display);
  const wasActive = useRef(active);
  // A terminal input reports its text again as it loses focus; by then the
  // field shows the formatted value, which must not come back as an edit.
  const editing = useRef(active);
  editing.current = active;
  useLayoutEffect(() => {
    if (active && !wasActive.current) setDraft(value > 0 ? String(value) : "");
    else if (!active) setDraft(display);
    wasActive.current = active;
  }, [active, display]);
  useEffect(() => {
    if (active && focused) input.current?.focus?.();
  }, [active, focused]);
  const fieldWidth = inputWidth ?? Math.max(8, width - labelWidth - 1);
  return (
    <Box
      ref={fieldRef}
      flexDirection="row"
      width={width}
      height={1}
      flexShrink={0}
      gap={1}
      alignItems="center"
      onMouseDown={onActivate}
    >
      <Box width={labelWidth} flexShrink={0} overflow="hidden">
        <Text fg={active ? colors.textBright : colors.textDim}>{label}</Text>
      </Box>
      {/* The desktop draws the field's box here so the number sits inset
          from its border; the terminal field is a filled row. */}
      <Box
        width={fieldWidth}
        height={1}
        flexShrink={0}
        flexDirection="row"
        alignItems="center"
        style={
          native
            ? {
                border: `1px solid ${active && focused ? colors.borderFocused : hairline()}`,
                borderRadius: RADIUS,
                paddingInline: 8,
                boxSizing: "border-box",
              }
            : undefined
        }
      >
        <NumberField
          inputRef={input}
          value={draft}
          placeholder={placeholder}
          focused={active && focused}
          width={native ? fieldWidth - 2 : fieldWidth}
          variant={native ? "plain" : "default"}
          backgroundColor={
            native ? "transparent" : active ? colors.selected : colors.panel
          }
          textColor={
            active && !native ? colors.selectedText : colors.textBright
          }
          placeholderColor={colors.textMuted}
          allowDecimal
          onMouseDown={onActivate}
          onChange={(text) => {
            if (!editing.current) return;
            setDraft(text);
            if (text.trim() === "") return onValue(0);
            const parsed = Number(text);
            if (Number.isFinite(parsed)) onValue(parsed);
          }}
        />
      </Box>
      {trailing}
    </Box>
  );
}

/** Muted text beside a field, such as a unit or what a percentage works out to. */
export function FieldNote({ children }: { children: ReactNode }) {
  return (
    <Box flexShrink={1} overflow="hidden">
      <Text fg={colors.textDim}>{children}</Text>
    </Box>
  );
}

export interface MenuChoice<T extends string> {
  value: T;
  label: string;
}
export interface MenuControl {
  open(): void;
}

/**
 * A trigger that opens a list of choices: a popover menu on the desktop, the
 * choice dialog in the terminal (which has no dropdown).
 */
export function MenuChoices<T extends string>({
  title,
  choices,
  value,
  onSelect,
  trigger,
  controlRef,
}: {
  title: string;
  choices: readonly MenuChoice<T>[];
  value: T | null;
  onSelect: (value: T) => void;
  trigger: ReactNode;
  controlRef?: Ref<MenuControl>;
}) {
  const native = useUiCapabilities().nativePaneChrome;
  const dialog = useDialog();
  const [open, setOpen] = useState(false);
  const show = () => {
    if (native) return setOpen(true);
    void dialog
      .prompt<string>({
        closeOnClickOutside: true,
        content: (context) => (
          <ChoiceDialog
            {...context}
            title={title}
            selectedChoiceId={value ?? undefined}
            choices={choices.map((choice) => ({
              id: choice.value,
              label: choice.label,
            }))}
          />
        ),
      })
      .then((next) => {
        const match = choices.find((choice) => choice.value === next);
        if (match) onSelect(match.value);
      })
      .catch(() => {});
  };
  useImperativeHandle(controlRef, () => ({ open: show }));
  if (!native) return <>{trigger}</>;
  return (
    <MenuPopover
      open={open}
      onOpenChange={setOpen}
      trigger={trigger}
      placement="bottom-end"
      label={title}
      selection="single"
      items={choices.map((choice) => ({
        id: choice.value,
        label: choice.label,
        selected: choice.value === value,
      }))}
      onSelect={(id) => {
        const match = choices.find((choice) => choice.value === id);
        if (match) onSelect(match.value);
      }}
    />
  );
}

export type MarginMode = "cross" | "isolated";

/** The leverages a click away on a market capped at `max`, ending with the cap. */
function leverageStops(max: number): number[] {
  const common = max <= 5 ? [1, 2, 3] : [1, 3, 5, 10, 20];
  return [...common.filter((value) => value < max), max];
}

/** Cells the leverage track keeps before the cap beside the number gives way. */
const MIN_TRACK = 14;

const clampLeverage = (value: number, max: number) =>
  Math.max(1, Math.min(max, Math.round(value)));

/**
 * Cells a segmented control takes: each option and a space either side in the
 * terminal, its padding on the desktop.
 */
const segmentsWidth = (labels: string[]) =>
  labels.reduce((total, label) => total + label.length + 2, 0);

/**
 * Leverage inline in the ticket, on two rows: the track with the number to
 * type or step and the market's cap, then the common values and the margin
 * mode. Left and Right step the number, Shift+Left/Right jump between the
 * common values, digits type a new one.
 */
export function LeverageControl({
  value,
  max,
  onChange,
  marginMode,
  onlyIsolated,
  onMarginMode,
  active,
  focused,
  onActivate,
  width,
  labelWidth,
  leverageRef,
  marginRef,
}: {
  value: number;
  max: number;
  onChange: (value: number) => void;
  marginMode: MarginMode;
  onlyIsolated: boolean;
  onMarginMode: (mode: MarginMode) => void;
  /** The part the ticket's field ring is on, if either. */
  active: "leverage" | "margin" | null;
  focused: boolean;
  onActivate: (part: "leverage" | "margin") => void;
  width: number;
  labelWidth: number;
  leverageRef?: (node: BoxRenderable | null) => void;
  marginRef?: (node: BoxRenderable | null) => void;
}) {
  const native = useUiCapabilities().nativePaneChrome;
  const stops = leverageStops(max);
  const editing = focused && active === "leverage";
  const change = (next: number) => {
    const clamped = clampLeverage(next, max);
    if (clamped !== value) onChange(clamped);
  };
  useShortcut(
    (event) => {
      if (event.name !== "left" && event.name !== "right") return;
      event.preventDefault();
      event.stopPropagation();
      const up = event.name === "right";
      if (!event.shift) return change(value + (up ? 1 : -1));
      const next = up
        ? stops.find((stop) => stop > value)
        : [...stops].reverse().find((stop) => stop < value);
      if (next != null) change(next);
    },
    {
      enabled: editing,
      allowEditable: true,
      phase: "before",
      scope: "hyperliquid-leverage",
    },
  );

  // The cap shows beside the number while the track keeps room to drag;
  // otherwise the last common value names it.
  const digits = String(max).length;
  const stepperWidth = (native ? 7 : 8) + digits;
  const showMax =
    width - labelWidth - stepperWidth - (digits + 3) - 3 >= MIN_TRACK;
  const chipLabel = (stop: number) =>
    stop === max && stops.length > 1 && showMax ? "Max" : `${stop}x`;
  // The common values give way until they share a row with the margin mode;
  // 1x and the cap stay.
  const chips = [...stops];
  const room = width - segmentsWidth(["Cross", "Isolated"]) - (native ? 2 : 1);
  for (const drop of [3, 2, 5, 10, 20]) {
    if (segmentsWidth(chips.map(chipLabel)) <= room) break;
    const at = chips.indexOf(drop);
    if (at > 0 && drop < max) chips.splice(at, 1);
  }
  const marginReason = onlyIsolated
    ? "This market trades isolated margin only"
    : undefined;

  return (
    <Box
      flexDirection="column"
      width={width}
      flexShrink={0}
      {...(native ? { style: { rowGap: 6 } } : {})}
    >
      <Box
        ref={leverageRef}
        flexDirection="row"
        width={width}
        height={1}
        gap={1}
        alignItems="center"
        flexShrink={0}
      >
        <Box width={labelWidth} flexShrink={0} overflow="hidden">
          <Text fg={active === "leverage" ? colors.textBright : colors.textDim}>
            Leverage
          </Text>
        </Box>
        <LeverageTrack
          value={value}
          max={max}
          stops={stops}
          focused={editing}
          onChange={change}
        />
        <LeverageStepper
          value={value}
          max={max}
          active={active === "leverage"}
          focused={focused}
          onActivate={() => onActivate("leverage")}
          onChange={change}
        />
        {showMax ? (
          <Box flexShrink={0}>
            <Text fg={colors.textDim}>{`/ ${max}x`}</Text>
          </Box>
        ) : null}
      </Box>
      <Box
        flexDirection="row"
        width={width}
        height={1}
        gap={1}
        alignItems="center"
        flexShrink={0}
      >
        <SegmentedControl
          value={chips.includes(value) ? String(value) : ""}
          options={chips.map((stop) => ({
            value: String(stop),
            label: chipLabel(stop),
          }))}
          onChange={(next) => change(Number(next))}
        />
        <Box flexGrow={1} />
        <Box
          ref={marginRef}
          flexShrink={0}
          {...(native && marginReason ? { title: marginReason } : {})}
        >
          <SegmentedControl
            value={onlyIsolated ? "isolated" : marginMode}
            options={[
              { value: "cross", label: "Cross", disabled: onlyIsolated },
              { value: "isolated", label: "Isolated" },
            ]}
            onChange={(next) => {
              onActivate("margin");
              if (next !== marginMode) onMarginMode(next as MarginMode);
            }}
            focused={focused && active === "margin"}
          />
        </Box>
      </Box>
      {marginReason && focused && active === "margin" ? (
        <Box width={width} flexShrink={0} alignItems="flex-end">
          <Text fg={colors.textDim}>{marginReason}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * The leverage track: click or drag anywhere on it. The desktop draws a rail
 * filled up to the value, ticks at the common values and a round handle; the
 * terminal keeps a row of cells.
 */
function LeverageTrack({
  value,
  max,
  stops,
  focused,
  onChange,
}: {
  value: number;
  max: number;
  stops: number[];
  focused: boolean;
  onChange: (value: number) => void;
}) {
  const native = useUiCapabilities().nativePaneChrome;
  const rail = useRef<BoxRenderable | null>(null);
  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  const pick = (event: {
    x?: number;
    pixelX?: number;
    preventDefault?: () => void;
  }) => {
    const node = rail.current;
    if (!node) return;
    event.preventDefault?.();
    const rect = native ? node.getBoundingClientRect?.() : undefined;
    const left = node.absoluteX ?? node.x ?? 0;
    // The desktop measures in pixels; in the terminal each cell is a position
    // and the last one is the cap.
    const ratio =
      rect && event.pixelX != null
        ? (event.pixelX - rect.x) / Math.max(1, rect.width)
        : ((event.x ?? left) - left) / Math.max(1, Number(node.width) - 1);
    onChange(1 + Math.max(0, Math.min(1, ratio)) * (max - 1));
  };
  const ratio = max > 1 ? (value - 1) / (max - 1) : 1;
  const at = (stop: number) =>
    `${(max > 1 ? (stop - 1) / (max - 1) : 1) * 100}%`;
  const lit = focused || hover || dragging;
  const handlers = {
    cursor: native ? (dragging ? "grabbing" : "pointer") : "pointer",
    role: "slider",
    "aria-label": "Leverage",
    "aria-valuemin": 1,
    "aria-valuemax": max,
    "aria-valuenow": value,
    "aria-valuetext": `${value}x`,
    "data-gloom-interactive": "true",
    onMouseDown: (event: any) => {
      setDragging(true);
      pick(event);
    },
    onMouseDrag: (event: any) => pick(event),
    onMouseDragEnd: () => setDragging(false),
    onMouseUp: () => setDragging(false),
    onMouseOver: () => setHover(true),
    onMouseOut: () => setHover(false),
  };

  if (!native)
    return (
      <Box
        ref={rail}
        flexDirection="row"
        height={1}
        flexGrow={1}
        flexBasis={0}
        minWidth={4}
        backgroundColor={colors.border}
        {...handlers}
      >
        <Box
          height={1}
          flexGrow={ratio}
          flexBasis={0}
          backgroundColor={colors.textDim}
        />
        <Box
          height={1}
          width={1}
          flexShrink={0}
          backgroundColor={colors.textBright}
        />
        <Box height={1} flexGrow={1 - ratio} flexBasis={0} />
      </Box>
    );

  const fill = lit ? colors.textBright : colors.borderFocused;
  return (
    // Inset by the handle's radius so the handle stays inside at either end.
    <Box
      height={1}
      flexGrow={1}
      flexBasis={0}
      minWidth={6}
      justifyContent="center"
      style={{ paddingInline: 8, boxSizing: "border-box" }}
      {...handlers}
    >
      <Box
        ref={rail}
        position="relative"
        style={{
          height: 4,
          minHeight: 4,
          borderRadius: 2,
          background: blendHex(colors.border, colors.textDim, 0.35),
        }}
      >
        <Box
          position="absolute"
          style={{
            left: 0,
            top: 0,
            height: 4,
            width: `${ratio * 100}%`,
            borderRadius: 2,
            background: fill,
          }}
        />
        {/* The ends are 1x and the cap; the ticks mark the values between. */}
        {stops.slice(1, -1).map((stop) => (
          <Box
            key={stop}
            position="absolute"
            style={{
              left: at(stop),
              top: -1,
              width: 6,
              height: 6,
              marginLeft: -3,
              borderRadius: "50%",
              background:
                stop <= value
                  ? blendHex(fill, colors.bg, 0.55)
                  : colors.textDim,
            }}
          />
        ))}
        <Box
          position="absolute"
          style={{
            left: `${ratio * 100}%`,
            top: -6,
            width: 16,
            height: 16,
            marginLeft: -8,
            borderRadius: "50%",
            boxSizing: "border-box",
            background: colors.textBright,
            border: `3px solid ${colors.bg}`,
            boxShadow: focused
              ? `0 0 0 2px ${colors.borderFocused}`
              : lit
                ? `0 0 0 4px ${blendHex(colors.bg, colors.textBright, 0.18)}`
                : `0 0 0 1px ${hairline()}`,
            cursor: dragging ? "grabbing" : "grab",
          }}
        />
      </Box>
    </Box>
  );
}

/**
 * The leverage number between a step down and a step up. A click on the
 * number or the field ring puts it in typing mode, empty with the current
 * value as a hint, so the digits typed replace it.
 */
function LeverageStepper({
  value,
  max,
  active,
  focused,
  onActivate,
  onChange,
}: {
  value: number;
  max: number;
  active: boolean;
  focused: boolean;
  onActivate: () => void;
  onChange: (value: number) => void;
}) {
  const native = useUiCapabilities().nativePaneChrome;
  const input = useRef<InputRenderable | null>(null);
  const [draft, setDraft] = useState("");
  // A terminal input reports its text again as it loses focus; that is not
  // an edit.
  const editing = useRef(active);
  editing.current = active;
  useLayoutEffect(() => {
    if (!active) setDraft("");
  }, [active]);
  // A step, a click on the track or a common value shows in the field.
  useLayoutEffect(() => {
    if (active && Number(draft) !== value) setDraft(String(value));
  }, [value]);
  useEffect(() => {
    if (active && focused) input.current?.focus?.();
  }, [active, focused]);
  const digits = String(max).length;
  const step = (label: string, name: string, delta: number) => {
    const disabled = delta < 0 ? value <= 1 : value >= max;
    const ink = disabled ? colors.textMuted : colors.text;
    // The desktop draws the minus and plus as bars, centred on the box.
    const bar = (vertical: boolean) => (
      <Box
        position="absolute"
        style={{
          left: "50%",
          top: "50%",
          width: vertical ? 2 : 10,
          height: vertical ? 10 : 2,
          marginLeft: vertical ? -1 : -5,
          marginTop: vertical ? -5 : -1,
          borderRadius: 1,
          background: ink,
        }}
      />
    );
    return (
      <Box
        width={native ? 2 : 3}
        height={1}
        flexShrink={0}
        alignItems="center"
        justifyContent="center"
        cursor={disabled ? "default" : "pointer"}
        role="button"
        aria-label={name}
        aria-disabled={disabled || undefined}
        data-gloom-interactive={disabled ? undefined : "true"}
        hoverBackgroundColor={
          native && !disabled
            ? blendHex(colors.bg, colors.textBright, 0.08)
            : undefined
        }
        onMouseDown={(event: { preventDefault?: () => void }) => {
          event.preventDefault?.();
          if (!disabled) onChange(value + delta);
        }}
        position={native ? "relative" : undefined}
        style={
          native
            ? { alignSelf: "stretch", borderRadius: RADIUS - 2 }
            : undefined
        }
      >
        {native ? (
          <>
            {bar(false)}
            {delta > 0 ? bar(true) : null}
          </>
        ) : (
          <Text fg={ink}>{label}</Text>
        )}
      </Box>
    );
  };
  return (
    <Box
      flexDirection="row"
      height={1}
      flexShrink={0}
      alignItems="center"
      backgroundColor={native ? undefined : colors.panel}
      style={
        native
          ? {
              border: `1px solid ${active && focused ? colors.borderFocused : hairline()}`,
              borderRadius: RADIUS,
              padding: 1,
              boxSizing: "border-box",
            }
          : undefined
      }
    >
      {step("\u2212", "Lower leverage", -1)}
      <Box
        width={digits + 2}
        height={1}
        flexShrink={0}
        flexDirection="row"
        alignItems="center"
        justifyContent={active ? "flex-start" : "center"}
        backgroundColor={
          active
            ? native
              ? blendHex(colors.bg, colors.textBright, 0.06)
              : colors.selected
            : undefined
        }
        cursor="text"
        onMouseDown={onActivate}
      >
        {active ? (
          <NumberField
            inputRef={input}
            value={draft}
            placeholder={String(value)}
            focused={focused}
            // A terminal input keeps a cell past the cursor, so there the x
            // gives up its cell while typing.
            width={digits + (native ? 1 : 2)}
            variant={native ? "plain" : "default"}
            backgroundColor={native ? "transparent" : colors.selected}
            textColor={native ? colors.textBright : colors.selectedText}
            placeholderColor={colors.textMuted}
            allowDecimal={false}
            onMouseDown={onActivate}
            onChange={(text) => {
              if (!editing.current) return;
              setDraft(text);
              const typed = Number(text);
              if (!text.trim() || !Number.isFinite(typed) || typed < 1) return;
              if (typed > max) setDraft(String(max));
              onChange(Math.min(typed, max));
            }}
          />
        ) : (
          <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>
            {String(value)}
          </Text>
        )}
        {native || !active ? (
          <Text
            fg={active ? colors.textDim : colors.textBright}
            attributes={active ? 0 : TextAttributes.BOLD}
          >
            x
          </Text>
        ) : null}
      </Box>
      {step("+", "Raise leverage", 1)}
    </Box>
  );
}

/** Figures in two columns, each a short label and its value. */
export function FigurePairs({
  items,
  width,
  labelWidth,
}: {
  items: { label: string; value: string; color?: string }[];
  width: number;
  labelWidth: number;
}) {
  const half = Math.floor((width - 1) / 2);
  const rows: (typeof items)[] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return (
    <Box flexDirection="column" flexShrink={0}>
      {rows.map((row, index) => (
        <Box key={index} flexDirection="row" gap={1} height={1}>
          {row.map((item) => (
            <KeyValueRow
              key={item.label}
              label={item.label}
              value={item.value}
              color={item.color}
              labelWidth={labelWidth}
              width={half}
              emphasis={false}
            />
          ))}
        </Box>
      ))}
    </Box>
  );
}

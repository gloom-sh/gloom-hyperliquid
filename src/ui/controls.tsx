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

/** Leverage as a track: drag or click it; the dialog that holds it steps it with the arrows. */
export function LeverageSlider({
  value,
  max,
  onChange,
  focused,
  width,
}: {
  value: number;
  max: number;
  onChange: (value: number) => void;
  focused: boolean;
  width: number;
}) {
  const native = useUiCapabilities().nativePaneChrome;
  const track = useRef<BoxRenderable | null>(null);
  const [dragging, setDragging] = useState(false);
  const change = (event: {
    x?: number;
    clientX?: number;
    currentTarget?: {
      getBoundingClientRect?: () => { left: number; width: number };
    };
    preventDefault?: () => void;
  }) => {
    const bounds = event.currentTarget?.getBoundingClientRect?.();
    const left = bounds?.left ?? track.current?.x ?? 0;
    const size = bounds?.width ?? track.current?.width ?? width;
    const x = event.clientX ?? event.x;
    if (x == null) return;
    event.preventDefault?.();
    onChange(
      Math.max(
        1,
        Math.min(
          max,
          Math.round(1 + ((x - left) / Math.max(1, Number(size))) * (max - 1)),
        ),
      ),
    );
  };
  const ratio = ((value - 1) / Math.max(1, max - 1)) * 100;
  return (
    <Box flexDirection="row" gap={1} alignItems="center" width={width}>
      <Box
        ref={track}
        height={1}
        flexGrow={1}
        flexBasis={0}
        minWidth={4}
        position="relative"
        cursor="pointer"
        backgroundColor={colors.border}
        role="slider"
        aria-label="Leverage"
        aria-valuemin={1}
        aria-valuemax={max}
        aria-valuenow={value}
        onMouseDown={(event: any) => {
          setDragging(true);
          change(event);
        }}
        onMouseDrag={(event: any) => change(event)}
        onMouseDragEnd={() => setDragging(false)}
        onMouseMove={(event: any) => {
          if (dragging) change(event);
        }}
        onMouseUp={() => setDragging(false)}
        style={
          native
            ? { height: "4px", minHeight: "4px", borderRadius: "2px" }
            : undefined
        }
      >
        <Box
          height={1}
          width={`${ratio}%`}
          backgroundColor={
            native
              ? focused
                ? colors.textBright
                : colors.borderFocused
              : colors.textDim
          }
          style={
            native
              ? { height: "4px", minHeight: "4px", borderRadius: "2px" }
              : undefined
          }
        />
        <Box
          position="absolute"
          left={native ? `${ratio}%` : `${Math.min(97, ratio)}%`}
          height={1}
          width={1}
          backgroundColor={colors.textBright}
          style={
            native
              ? {
                  width: "12px",
                  height: "12px",
                  minHeight: "12px",
                  top: "-4px",
                  marginLeft: "-6px",
                  borderRadius: "50%",
                  boxShadow: focused
                    ? `0 0 0 3px ${colors.borderFocused}`
                    : undefined,
                }
              : undefined
          }
        />
      </Box>
      <Text fg={colors.textBright}>{`${value}x`}</Text>
      <Text fg={colors.textDim}>{`/ ${max}x`}</Text>
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

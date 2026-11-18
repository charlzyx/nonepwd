import {
  Image,
  Scroll,
  Text,
  View,
  platform,
  token,
  type ImageAsset,
  type InputHostProps,
  type InputStyle,
  type JSX,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "nsh";
import { Button, Input, Select, Sheet, Tab, Tabs, type SelectItem } from "nsh/base";
import { Haptics } from "nsh/mobile";
import type { ItemCategory } from "./crypto";
import chevronDownIcon from "./icons/chevron-down.png";
import searchIcon from "./icons/search.png";
import xIcon from "./icons/x.png";

// ---------- 5-Step Typography Scale + Mono Hero ----------

export function PageTitle(props: { children: JSX.Element; class?: string; style?: StyleProp<TextStyle> }) {
  return (
    <Text
      class={`text-[24px] font-bold tracking-tight text-foreground ${props.class ?? ""}`}
      style={props.style}
    >
      {props.children}
    </Text>
  );
}

export function SectionTitle(props: { children: JSX.Element; class?: string; style?: StyleProp<TextStyle> }) {
  return (
    <Text
      class={`text-[17px] font-semibold tracking-tight text-foreground ${props.class ?? ""}`}
      style={props.style}
    >
      {props.children}
    </Text>
  );
}

export const SheetTitle = SectionTitle;

export function SectionHeader(props: {
  title: string;
  rightSlot?: JSX.Element;
  class?: string;
}) {
  return (
    <View class={`flex-row items-center justify-between gap-2 px-1 ${props.class ?? ""}`}>
      <Text role="header" class="flex-1 min-w-0 text-[13px] font-semibold text-muted-foreground">
        {props.title}
      </Text>
      <If when={props.rightSlot}>
        <View class="shrink-0">{props.rightSlot}</View>
      </If>
    </View>
  );
}

export function BodyText(props: {
  children: JSX.Element;
  class?: string;
  style?: StyleProp<TextStyle>;
  lineClamp?: 1 | 2;
}) {
  const clampClass = () =>
    props.lineClamp === 1 ? "line-clamp-1" : props.lineClamp === 2 ? "line-clamp-2" : "";
  return (
    <Text
      class={`text-[15px] text-foreground ${clampClass()} ${props.class ?? ""}`}
      style={props.style}
    >
      {props.children}
    </Text>
  );
}

export function SubheadText(props: {
  children: JSX.Element;
  class?: string;
  style?: StyleProp<TextStyle>;
  lineClamp?: 1 | 2;
}) {
  const clampClass = () =>
    props.lineClamp === 1 ? "line-clamp-1" : props.lineClamp === 2 ? "line-clamp-2" : "";
  return (
    <Text
      class={`text-[13px] text-muted-foreground ${clampClass()} ${props.class ?? ""}`}
      style={props.style}
    >
      {props.children}
    </Text>
  );
}

export function CaptionText(props: {
  children: JSX.Element;
  class?: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  return (
    <Text
      class={`text-[11.5px] font-semibold ${props.class ?? "text-muted-foreground"}`}
      style={[
        props.numberOfLines !== undefined ? { numberOfLines: props.numberOfLines } : undefined,
        props.style,
      ]}
    >
      {props.children}
    </Text>
  );
}

function formatOtpGroups(raw: string): string[] {
  const code = raw.trim();
  if (!code || code === "------") return ["---", "---"];
  if (/^\d{6}$/.test(code)) return [code.slice(0, 3), code.slice(3)];
  if (/^\d{8}$/.test(code)) return [code.slice(0, 4), code.slice(4)];
  return [code];
}

export function OtpHeroText(props: {
  code: string;
  size?: "hero" | "compact";
  class?: string;
}) {
  const parts = () => formatOtpGroups(props.code);
  return (
    <View
      accessibilityLabel={props.code}
      class={`shrink-0 flex-row items-center gap-1.5 ${props.class ?? ""}`}
    >
      <Each of={parts()} key="index">
        {(part) => (
          <Text
            class={`shrink-0 font-mono font-bold text-primary px-0.5 ${
              props.size === "compact" ? "text-[24px]" : "text-[26px]"
            }`}
            style={{
              fontVariant: ["tabular-nums"],
              numberOfLines: 1,
              textOverflow: "clip",
            }}
          >
            {part()}
          </Text>
        )}
      </Each>
    </View>
  );
}

// ---------- Fixed-Height Buttons & Controls (h-11 / h-9 / h-8) ----------

export type ActionButtonVariant = "primary" | "secondary" | "danger" | "ghost";

export interface ActionButtonProps {
  label: string;
  variant?: ActionButtonVariant;
  icon?: ImageAsset;
  disabled?: boolean;
  testID?: string;
  class?: string;
  onPress?: () => void;
}

export function ActionButton(props: ActionButtonProps) {
  const variant = () => props.variant ?? "primary";
  const containerBg = () => {
    switch (variant()) {
      case "secondary":
        return "bg-secondary active:opacity-80";
      case "danger":
        return "bg-destructive active:opacity-85";
      case "ghost":
        return "bg-transparent active:opacity-70";
      case "primary":
      default:
        return "bg-primary active:opacity-85";
    }
  };
  const labelStyle = () => {
    switch (variant()) {
      case "secondary":
        return "text-[15px] font-semibold text-foreground";
      case "danger":
        return "text-[15px] font-semibold text-primary-foreground";
      case "ghost":
        return "text-[14px] font-medium text-muted-foreground";
      case "primary":
      default:
        return "text-[15px] font-semibold text-primary-foreground";
    }
  };
  const iconTint = () => {
    switch (variant()) {
      case "secondary":
        return token("foreground");
      case "ghost":
        return token("muted-foreground");
      case "danger":
      case "primary":
      default:
        return token("primary-foreground");
    }
  };

  return (
    <Button
      testID={props.testID}
      disabled={props.disabled}
      onPress={() => props.onPress?.()}
      class={`h-11 rounded-xl px-4 items-center justify-center flex-row gap-2 disabled:opacity-50 ${containerBg()} ${
        props.class ?? ""
      }`}
    >
      <If when={props.icon}>
        {(ic) => <Image src={ic()} class="h-[18px] w-[18px] shrink-0" style={{ tintColor: iconTint() }} />}
      </If>
      <Text class={labelStyle()} style={{ numberOfLines: 1 }}>
        {props.label}
      </Text>
    </Button>
  );
}

export type CompactButtonVariant = "primary" | "tonal" | "neutral" | "card" | "danger";

export interface CompactButtonProps {
  label: string;
  variant?: CompactButtonVariant;
  icon?: ImageAsset;
  pill?: boolean;
  disabled?: boolean;
  testID?: string;
  class?: string;
  onPress?: () => void;
}

export function CompactButton(props: CompactButtonProps) {
  const variant = () => props.variant ?? "neutral";
  const bgClass = () => {
    switch (variant()) {
      case "primary":
        return "bg-primary active:opacity-85";
      case "tonal":
        return "bg-primary/12 active:opacity-75";
      case "card":
        return "bg-card border border-border active:opacity-75";
      case "danger":
        return "bg-destructive/12 active:opacity-75";
      case "neutral":
      default:
        return "bg-muted active:opacity-75";
    }
  };
  const textClass = () => {
    switch (variant()) {
      case "primary":
        return "text-primary-foreground";
      case "tonal":
        return "text-primary";
      case "danger":
        return "text-destructive";
      case "card":
      case "neutral":
      default:
        return "text-foreground";
    }
  };
  const iconTint = () => {
    switch (variant()) {
      case "primary":
        return token("primary-foreground");
      case "tonal":
        return token("primary");
      case "danger":
        return token("destructive");
      case "card":
      case "neutral":
      default:
        return token("foreground");
    }
  };

  return (
    <Button
      testID={props.testID}
      disabled={props.disabled}
      onPress={() => props.onPress?.()}
      class={`shrink-0 h-9 ${
        props.pill ? "rounded-full" : "rounded-lg"
      } px-3 items-center justify-center flex-row gap-1.5 disabled:opacity-50 ${bgClass()} ${
        props.class ?? ""
      }`}
    >
      <If when={props.icon}>
        {(ic) => <Image src={ic()} class="h-4 w-4 shrink-0" style={{ tintColor: iconTint() }} />}
      </If>
      <Text
        class={`text-[13px] font-semibold ${textClass()}`}
        style={{ numberOfLines: 1 }}
      >
        {props.label}
      </Text>
    </Button>
  );
}

export interface FilterPillProps {
  label: string;
  selected: boolean;
  surface?: "canvas" | "card";
  testID?: string;
  class?: string;
  onPress?: () => void;
}

export function FilterPill(props: FilterPillProps) {
  const unselectedBg = () => (props.surface === "card" ? "bg-input" : "bg-card");
  return (
    <Button
      testID={props.testID}
      selected={props.selected}
      onPress={() => {
        Haptics.selection();
        props.onPress?.();
      }}
      class={`shrink-0 h-8 rounded-full px-3 items-center justify-center flex-row gap-1.5 active:opacity-80 ${
        props.selected ? "bg-primary" : unselectedBg()
      } ${props.class ?? ""}`}
    >
      <Text
        class={`text-[13px] ${
          props.selected
            ? "font-semibold text-primary-foreground"
            : "font-medium text-muted-foreground"
        }`}
        style={{ numberOfLines: 1 }}
      >
        {props.label}
      </Text>
    </Button>
  );
}

export interface SegmentedOption<T extends string> {
  key: T;
  label: string;
  testID?: string;
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (key: T) => void;
  class?: string;
  testID?: string;
}

export function SegmentedControl<T extends string>(props: SegmentedControlProps<T>) {
  return (
    <Tabs
      testID={props.testID}
      indicatorClass="inset-y-1 rounded-[8px] bg-card"
      class={`h-10 rounded-xl bg-muted p-1 flex-row gap-1 ${props.class ?? ""}`}
    >
      <Each of={props.options} key={(o) => o.key}>
        {(opt) => (
          <Tab
            testID={opt().testID}
            selected={props.value === opt().key}
            onPress={() => {
              Haptics.selection();
              props.onChange(opt().key);
            }}
            class="flex-1 h-8 rounded-[8px] items-center justify-center px-2"
          >
            <Text
              class={`text-[13px] ${
                props.value === opt().key
                  ? "font-semibold text-foreground"
                  : "font-medium text-muted-foreground"
              }`}
              style={{ numberOfLines: 1 }}
            >
              {opt().label}
            </Text>
          </Tab>
        )}
      </Each>
    </Tabs>
  );
}

// ---------- Select Dropdown / Sheet ----------

export interface AppSelectProps {
  items: readonly SelectItem[];
  value: string | null;
  onChange: (value: string) => void;
  placeholder?: string;
  accessibilityLabel?: string;
  surface?: "canvas" | "card";
  testID?: string;
  class?: string;
}

export function AppSelect(props: AppSelectProps) {
  const selectedTitle = () =>
    props.items.find((it) => it.value === props.value)?.title ??
    props.placeholder ??
    "请选择";

  return (
    <Select
      testID={props.testID}
      items={[...props.items]}
      value={props.value}
      placeholder={props.placeholder}
      accessibilityLabel={props.accessibilityLabel}
      onChange={(e) => {
        if (e.value) {
          Haptics.selection();
          props.onChange(e.value);
        }
      }}
      popupClass={
        platform.desktop
          ? "rounded-xl bg-card border border-border p-2"
          : "rounded-t-[24px] bg-card border-t border-border p-4 pb-[calc(env(safe-area-inset-bottom)+16px)]"
      }
      backdropClass="bg-black/45"
      listClass="gap-1"
      itemClass="h-11 rounded-lg px-3 flex-row items-center justify-between selected:bg-primary/12 focus:bg-muted"
      itemStyle={{ color: token("foreground"), fontSize: 15 }}
      class={props.class}
      trigger={
        <View
          class={`h-11 rounded-xl px-3 flex-row items-center justify-between gap-2 ${
            props.surface === "card" ? "bg-input" : "bg-card border border-border"
          }`}
        >
          <Text class="flex-1 min-w-0 line-clamp-1 text-[15px] font-medium text-foreground">
            {selectedTitle()}
          </Text>
          <Image
            src={chevronDownIcon}
            class="h-4 w-4 shrink-0"
            style={{ tintColor: token("muted-foreground") }}
          />
        </View>
      }
    />
  );
}

// ---------- Inputs & Form Fields ----------

export interface AppInputProps {
  testID?: string;
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  masked?: boolean;
  multiline?: boolean;
  mono?: boolean;
  surface?: "card" | "canvas";
  keyboardType?: InputHostProps["keyboardType"];
  returnKeyType?: InputHostProps["returnKeyType"];
  autoCapitalize?: InputHostProps["autoCapitalize"];
  autoCorrect?: InputHostProps["autoCorrect"];
  autoComplete?: InputHostProps["autoComplete"];
  readonly?: boolean;
  class?: string;
  style?: StyleProp<InputStyle>;
  onChange?: (e: { value: string }) => void;
  onSubmit?: (e: { text: string }) => void;
}

export function AppInput(props: AppInputProps) {
  const fillClass = () => (props.surface === "canvas" ? "bg-card" : "bg-input");
  const sizeClass = () =>
    props.multiline
      ? `min-h-[92px] rounded-xl p-3 ${
          props.mono ? "font-mono text-[14px]" : "text-[15px]"
        }`
      : `h-11 rounded-xl px-3 ${
          props.mono ? "font-mono text-[14px]" : "text-[15px]"
        }`;

  return (
    <Input
      testID={props.testID}
      value={props.value}
      defaultValue={props.defaultValue}
      placeholder={props.placeholder}
      masked={props.masked}
      multiline={props.multiline}
      keyboardType={props.keyboardType}
      returnKeyType={props.returnKeyType}
      autoCapitalize={props.autoCapitalize}
      autoCorrect={props.autoCorrect}
      autoComplete={props.autoComplete}
      readonly={props.readonly}
      onChange={(e) => props.onChange?.(e)}
      onSubmit={(e) => props.onSubmit?.(e)}
      class={`${fillClass()} ${sizeClass()} text-foreground ${props.class ?? ""}`}
      style={[{ placeholderColor: token("muted-foreground") }, props.style]}
    />
  );
}

export interface FormFieldProps {
  label: string;
  rightSlot?: JSX.Element;
  children?: JSX.Element;
  class?: string;
}

export function FormField(props: FormFieldProps) {
  return (
    <View class={`gap-2 ${props.class ?? ""}`}>
      <View class="flex-row items-center justify-between gap-2">
        <Text class="flex-1 min-w-0 text-[13px] font-medium text-muted-foreground">{props.label}</Text>
        <If when={props.rightSlot}>
          <View class="shrink-0">{props.rightSlot}</View>
        </If>
      </View>
      {props.children}
    </View>
  );
}

export interface SearchBarProps {
  testID?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  surface?: "canvas" | "card";
  class?: string;
}

export function SearchBar(props: SearchBarProps) {
  const bgClass = () => (props.surface === "card" ? "bg-input" : "bg-card");
  return (
    <View
      class={`h-11 rounded-xl px-3 flex-row items-center gap-2 ${bgClass()} ${
        props.class ?? ""
      }`}
    >
      <Image
        src={searchIcon}
        class="h-4 w-4 shrink-0"
        style={{ tintColor: token("muted-foreground") }}
      />
      <Input
        testID={props.testID}
        value={props.value}
        onChange={(e) => props.onChange(e.value)}
        placeholder={props.placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        class="flex-1 min-w-0 h-full bg-transparent text-[15px] text-foreground"
        style={{ placeholderColor: token("muted-foreground") }}
      />
      <If when={props.value.length > 0}>
        <Button
          onPress={() => props.onChange("")}
          hitSlop={8}
          accessibilityLabel="清除搜索"
          class="shrink-0 h-6 w-6 items-center justify-center rounded-full bg-input active:opacity-75"
        >
          <Image
            src={xIcon}
            class="h-3.5 w-3.5 shrink-0"
            style={{ tintColor: token("muted-foreground") }}
          />
        </Button>
      </If>
    </View>
  );
}

// ---------- Quiet Grouped Lists & Surfaces ----------

export function GroupedList(props: {
  children?: JSX.Element;
  surface?: "canvas" | "sheet";
  class?: string;
}) {
  const bg = () => (props.surface === "sheet" ? "bg-background" : "bg-card");
  return (
    <View class={`rounded-xl border border-border overflow-hidden ${bg()} ${props.class ?? ""}`}>
      {props.children}
    </View>
  );
}

export function GroupedRow(props: {
  children?: JSX.Element;
  last?: boolean;
  onPress?: () => void;
  selected?: boolean;
  testID?: string;
  class?: string;
}) {
  const border = () => (props.last ? "" : "border-b border-border");
  const sel = () => (props.selected ? "bg-primary/12" : "");
  const cls = () => `min-h-[52px] px-4 py-3 ${border()} ${sel()} ${props.class ?? ""}`;

  if (props.onPress) {
    return (
      <Button
        testID={props.testID}
        selected={props.selected}
        onPress={() => props.onPress?.()}
        class={`${cls()} active:opacity-80`}
      >
        {props.children}
      </Button>
    );
  }
  return (
    <View testID={props.testID} class={cls()}>
      {props.children}
    </View>
  );
}

export interface SurfaceCardProps {
  children?: JSX.Element;
  onPress?: () => void;
  selected?: boolean;
  testID?: string;
  class?: string;
  style?: StyleProp<ViewStyle>;
}

export function SurfaceCard(props: SurfaceCardProps) {
  const baseClass = () =>
    `rounded-2xl p-4 gap-3 ${
      props.selected ? "bg-primary/12" : "bg-card"
    } ${props.class ?? ""}`;

  if (props.onPress) {
    return (
      <Button
        testID={props.testID}
        selected={props.selected}
        onPress={() => props.onPress?.()}
        class={`${baseClass()} active:opacity-85`}
        style={props.style}
      >
        {props.children}
      </Button>
    );
  }

  return (
    <View testID={props.testID} class={baseClass()} style={props.style}>
      {props.children}
    </View>
  );
}

export interface InsetCardProps {
  children?: JSX.Element;
  onPress?: () => void;
  testID?: string;
  class?: string;
  style?: StyleProp<ViewStyle>;
}

export function InsetCard(props: InsetCardProps) {
  const baseClass = () => `rounded-xl bg-input p-3 gap-2 ${props.class ?? ""}`;
  if (props.onPress) {
    return (
      <Button
        testID={props.testID}
        onPress={() => props.onPress?.()}
        class={`${baseClass()} active:opacity-80`}
        style={props.style}
      >
        {props.children}
      </Button>
    );
  }
  return (
    <View testID={props.testID} class={baseClass()} style={props.style}>
      {props.children}
    </View>
  );
}

function extractAvatarMonogram(title: string): string {
  const cleaned = title.replace(/^[\s"'`[\]({<]+/, "").trim();
  if (!cleaned) return "N";
  const first = Array.from(cleaned)[0] ?? "N";
  return first.toUpperCase();
}

function avatarColorForCategory(cat: ItemCategory | "email", title: string): string {
  if (cat === "email") {
    const emailTokens = [
      token("chart-1"),
      token("chart-5"),
      token("chart-4"),
      token("chart-2"),
      token("chart-3"),
    ];
    let hash = 0;
    for (let i = 0; i < title.length; i++) {
      hash = (hash * 31 + title.charCodeAt(i)) >>> 0;
    }
    return emailTokens[hash % emailTokens.length];
  }
  switch (cat) {
    case "api_credential":
      return token("chart-4");
    case "ssh_key":
      return token("muted-foreground");
    case "card":
      return token("chart-2");
    case "identity":
      return token("chart-5");
    case "secure_note":
      return token("chart-3");
    case "login":
    default:
      return token("chart-1");
  }
}

export interface ItemAvatarProps {
  title: string;
  category?: ItemCategory | "email";
  size?: "sm" | "md";
  class?: string;
}

export function ItemAvatar(props: ItemAvatarProps) {
  const bgColor = () => avatarColorForCategory(props.category ?? "login", props.title);
  const boxClass = () =>
    props.size === "sm"
      ? "h-9 w-9 rounded-[10px]"
      : "h-[42px] w-[42px] rounded-xl";
  const textClass = () => (props.size === "sm" ? "text-[14px]" : "text-[16px]");

  return (
    <View
      class={`shrink-0 ${boxClass()} items-center justify-center ${props.class ?? ""}`}
      style={{ backgroundColor: bgColor() }}
    >
      <Text class={`${textClass()} font-bold text-primary-foreground`}>
        {extractAvatarMonogram(props.title)}
      </Text>
    </View>
  );
}

// ---------- Sheet & Screen Chrome ----------

export interface SheetContainerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  closeLabel?: string;
  closeOnSwipe?: boolean;
  scrollable?: boolean;
  headerExtra?: JSX.Element;
  footer?: JSX.Element;
  children?: JSX.Element;
}

export function SheetContainer(props: SheetContainerProps) {
  const isScrollable = () => props.scrollable ?? true;
  return (
    <Sheet
      open={props.open}
      onOpenChange={(e) => {
        if (!e.open) props.onClose();
      }}
      side="bottom"
      closeOnSwipe={props.closeOnSwipe ?? true}
      popupClass="bg-card rounded-t-[24px] px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+16px)] max-h-[90%]"
      backdropClass="bg-black/45"
    >
      <View class="gap-3">
        {/* Drag Handle */}
        <View class="h-1 w-9 self-center rounded-full bg-muted-foreground/25" />

        {/* Header */}
        <View class="flex-row items-start justify-between gap-3">
          <View class="flex-1 min-w-0 gap-1">
            <SheetTitle>{props.title}</SheetTitle>
            <If when={props.subtitle}>
              {(sub) => <SubheadText>{sub()}</SubheadText>}
            </If>
          </View>
          <CompactButton
            label={props.closeLabel ?? "关闭"}
            variant="neutral"
            pill
            onPress={() => props.onClose()}
          />
        </View>

        <If when={props.headerExtra}>{props.headerExtra}</If>

        <If
          when={isScrollable()}
          else={<View class="gap-4">{props.children}</View>}
        >
          <Scroll class="max-h-[450px]" contentClass="gap-4 pb-2">
            {props.children}
          </Scroll>
        </If>

        <If when={props.footer}>
          {(foot) => <View class="pt-1">{foot()}</View>}
        </If>
      </View>
    </Sheet>
  );
}

export interface ScreenHeaderProps {
  title: string;
  badge?: string;
  rightSlot?: JSX.Element;
  children?: JSX.Element;
  class?: string;
}

export function ScreenHeader(props: ScreenHeaderProps) {
  return (
    <View class={`px-4 pt-3 pb-2 gap-3 ${props.class ?? ""}`}>
      <View class="flex-row items-center justify-between gap-2">
        <View class="flex-1 min-w-0 flex-row items-center gap-2">
          <PageTitle>{props.title}</PageTitle>
          <If when={props.badge}>
            {(b) => (
              <View class="shrink-0 rounded-full bg-primary/12 px-3 py-1">
                <CaptionText numberOfLines={1} class="text-primary">
                  {b()}
                </CaptionText>
              </View>
            )}
          </If>
        </View>
        <If when={props.rightSlot}>
          <View class="shrink-0">{props.rightSlot}</View>
        </If>
      </View>
      <If when={props.children}>{props.children}</If>
    </View>
  );
}

// ---------- Badges & Feedback ----------

export type BadgeTone = "primary" | "neutral" | "success" | "warning" | "danger";

export function BadgePill(props: { label: string; tone?: BadgeTone; class?: string }) {
  const toneClass = () => {
    switch (props.tone ?? "neutral") {
      case "primary":
        return { bg: "bg-primary/12", text: "text-primary" };
      case "success":
        return { bg: "bg-chart-2/15", text: "text-chart-2" };
      case "warning":
        return { bg: "bg-chart-3/15", text: "text-chart-3" };
      case "danger":
        return { bg: "bg-destructive/15", text: "text-destructive" };
      case "neutral":
      default:
        return { bg: "bg-muted", text: "text-muted-foreground" };
    }
  };
  return (
    <View class={`shrink-0 rounded-full px-3 py-1 ${toneClass().bg} ${props.class ?? ""}`}>
      <CaptionText numberOfLines={1} class={toneClass().text}>
        {props.label}
      </CaptionText>
    </View>
  );
}

export function FeedbackBanner(props: { kind: "ok" | "error" | "info" | "warning"; text: string; class?: string }) {
  const styleClass = () => {
    switch (props.kind) {
      case "error":
        return { box: "bg-destructive/12", text: "text-destructive" };
      case "ok":
        return { box: "bg-chart-2/15", text: "text-chart-2" };
      case "warning":
        return { box: "bg-chart-3/15", text: "text-chart-3" };
      case "info":
      default:
        return { box: "bg-muted", text: "text-foreground" };
    }
  };
  return (
    <View class={`rounded-xl px-3 py-2 ${styleClass().box} ${props.class ?? ""}`}>
      <Text class={`text-[13px] font-medium ${styleClass().text}`}>{props.text}</Text>
    </View>
  );
}

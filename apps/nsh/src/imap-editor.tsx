import { Scroll, Text, View, batch, effect, signal } from "nsh";
import { Button, Input, Sheet, Switch } from "nsh/base";
import { Haptics } from "nsh/mobile";
import {
  IMAP_PROVIDER_PRESETS,
  type ImapAccountPublic,
  type SaveImapAccountInput,
} from "./api";

export interface ImapEditorSheetProps {
  open: boolean;
  initialAccount: ImapAccountPublic | null;
  onTest: (input: {
    id?: string;
    host: string;
    port: number;
    tls: boolean;
    username: string;
    password?: string;
  }) => Promise<{ ok: boolean; messages?: number; error?: string }>;
  onSave: (input: SaveImapAccountInput) => Promise<void>;
  onClose: () => void;
}

export function ImapEditorSheet(props: ImapEditorSheetProps) {
  const label = signal("");
  const host = signal("");
  const portText = signal("993");
  const tls = signal(true);
  const username = signal("");
  const password = signal("");
  const enabled = signal(true);

  const testing = signal(false);
  const saving = signal(false);
  const feedback = signal<{ kind: "ok" | "error" | "info"; text: string } | null>(null);

  effect(() => {
    if (!props.open) return;
    const acc = props.initialAccount;
    batch(() => {
      feedback.set(null);
      testing.set(false);
      saving.set(false);
      label.set(acc?.label ?? "");
      host.set(acc?.host ?? "");
      portText.set(String(acc?.port ?? 993));
      tls.set(acc?.tls ?? true);
      username.set(acc?.username ?? "");
      password.set("");
      enabled.set(acc?.enabled ?? true);
    });
  });

  function applyPreset(preset: (typeof IMAP_PROVIDER_PRESETS)[number]) {
    Haptics.selection();
    batch(() => {
      if (preset.host) {
        host.set(preset.host);
      }
      portText.set(String(preset.port));
      tls.set(preset.tls);
      if (!label().trim() && preset.key !== "custom") {
        label.set(preset.label);
      }
    });
  }

  async function handleTest() {
    const h = host().trim();
    const u = username().trim();
    if (!h || !u) {
      feedback.set({ kind: "error", text: "请先填写 IMAP 服务器与邮箱账号" });
      return;
    }
    testing.set(true);
    feedback.set({ kind: "info", text: "正在测试 IMAP 连接..." });
    try {
      const port = Number.parseInt(portText(), 10) || 993;
      const res = await props.onTest({
        id: props.initialAccount?.id,
        host: h,
        port,
        tls: tls(),
        username: u,
        password: password() || undefined,
      });
      if (res.ok) {
        feedback.set({
          kind: "ok",
          text: `连接成功！INBOX 当前共有 ${res.messages ?? 0} 封邮件`,
        });
        Haptics.notification("success");
      } else {
        feedback.set({
          kind: "error",
          text: `连接失败：${res.error ?? "未知错误"}`,
        });
      }
    } catch (err) {
      feedback.set({
        kind: "error",
        text: err instanceof Error ? err.message : "测试连接失败",
      });
    } finally {
      testing.set(false);
    }
  }

  async function handleSubmit() {
    const h = host().trim();
    const u = username().trim();
    const port = Number.parseInt(portText(), 10) || 993;
    const isNew = !props.initialAccount;

    if (!h) {
      feedback.set({ kind: "error", text: "请填写 IMAP Host（可点上方邮箱预设）" });
      return;
    }
    if (!u) {
      feedback.set({ kind: "error", text: "请填写邮箱账号" });
      return;
    }
    if (isNew && !password().trim()) {
      feedback.set({ kind: "error", text: "添加邮箱账号时请填写应用专用密码 / 授权码" });
      return;
    }

    saving.set(true);
    feedback.set(null);
    try {
      await props.onSave({
        ...(props.initialAccount?.id ? { id: props.initialAccount.id } : {}),
        label: label().trim() || u,
        enabled: enabled(),
        host: h,
        port,
        tls: tls(),
        username: u,
        ...(password().trim() ? { password: password() } : {}),
      });
      Haptics.notification("success");
      props.onClose();
    } catch (err) {
      feedback.set({
        kind: "error",
        text: err instanceof Error ? err.message : "保存邮箱账号失败",
      });
    } finally {
      saving.set(false);
    }
  }

  return (
    <Sheet
      open={props.open}
      onOpenChange={(e) => {
        if (!e.open) props.onClose();
      }}
      side="bottom"
      closeOnSwipe
      popupClass="bg-card rounded-t-2xl border-t border-border p-4 pb-[calc(env(safe-area-inset-bottom)+16px)] max-h-[90%]"
      backdropClass="bg-black/45"
    >
      <View class="gap-3">
        <View class="flex-row items-center justify-between">
          <View class="gap-0.5">
            <Text class="text-lg font-semibold text-foreground">
              {props.initialAccount ? "编辑 IMAP 邮箱" : "添加 IMAP 收信邮箱"}
            </Text>
            <Text class="text-xs text-muted-foreground">
              支持同一服务商添加任意多个账号，互不限制
            </Text>
          </View>
          <Button
            onPress={props.onClose}
            class="rounded-full bg-muted px-3 py-1.5 active:opacity-75"
          >
            <Text class="text-xs font-medium text-foreground">取消</Text>
          </Button>
        </View>

        <Scroll class="max-h-[430px]" contentClass="gap-3 pb-2">
          {/* Provider Presets */}
          <View class="gap-1.5">
            <Text class="text-xs font-medium text-muted-foreground">快速服务商预设</Text>
            <View class="flex-row flex-wrap gap-1.5">
              <Each of={IMAP_PROVIDER_PRESETS}>
                {(preset) => (
                  <Button
                    onPress={() => applyPreset(preset())}
                    class={`rounded-full border px-3 py-1.5 ${
                      preset().host && host() === preset().host
                        ? "border-primary bg-primary"
                        : "border-border bg-background"
                    }`}
                  >
                    <Text
                      class={`text-xs font-medium ${
                        preset().host && host() === preset().host
                          ? "text-primary-foreground"
                          : "text-foreground"
                      }`}
                    >
                      {preset().label}
                    </Text>
                  </Button>
                )}
              </Each>
            </View>
          </View>

          <View class="gap-1">
            <Text class="text-xs font-medium text-muted-foreground">账号备注名称</Text>
            <Input
              value={label()}
              onChange={(e) => label.set(e.value)}
              placeholder="例如 工作 Gmail / 个人 QQ"
              class="rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground"
            />
          </View>

          <View class="flex-row gap-2">
            <View class="flex-1 gap-1">
              <Text class="text-xs font-medium text-muted-foreground">IMAP 服务器 (Host)</Text>
              <Input
                value={host()}
                onChange={(e) => host.set(e.value)}
                placeholder="imap.gmail.com"
                autoCapitalize="none"
                autoCorrect={false}
                class="rounded-xl border border-input bg-background px-3 py-2.5 text-xs text-foreground"
              />
            </View>
            <View class="w-24 gap-1">
              <Text class="text-xs font-medium text-muted-foreground">端口</Text>
              <Input
                value={portText()}
                onChange={(e) => portText.set(e.value)}
                keyboardType="number-pad"
                placeholder="993"
                class="rounded-xl border border-input bg-background px-3 py-2.5 text-xs text-foreground"
              />
            </View>
          </View>

          <View class="gap-1">
            <Text class="text-xs font-medium text-muted-foreground">邮箱账号</Text>
            <Input
              value={username()}
              onChange={(e) => username.set(e.value)}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="you@gmail.com"
              class="rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground"
            />
          </View>

          <View class="gap-1">
            <Text class="text-xs font-medium text-muted-foreground">
              {props.initialAccount
                ? "应用专用密码 / 授权码 (留空保持不变)"
                : "应用专用密码 / 授权码"}
            </Text>
            <Input
              value={password()}
              onChange={(e) => password.set(e.value)}
              masked
              placeholder={props.initialAccount?.hasPassword ? "已加密保存，留空则不修改" : "输入授权码"}
              autoCapitalize="none"
              autoCorrect={false}
              class="rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground"
            />
          </View>

          <View class="flex-row items-center justify-between rounded-xl border border-border bg-background px-3 py-2.5">
            <Text class="text-xs font-medium text-foreground">使用 SSL/TLS 加密连接</Text>
            <Switch
              checked={tls()}
              onChange={(e) => tls.set(e.checked)}
              trackClass="w-10 h-6 rounded-full bg-muted checked:bg-primary p-0.5 justify-center"
              thumbClass="w-5 h-5 rounded-full bg-background checked:translate-x-4"
            />
          </View>

          <View class="flex-row items-center justify-between rounded-xl border border-border bg-background px-3 py-2.5">
            <Text class="text-xs font-medium text-foreground">启用此邮箱自动收信</Text>
            <Switch
              checked={enabled()}
              onChange={(e) => enabled.set(e.checked)}
              trackClass="w-10 h-6 rounded-full bg-muted checked:bg-primary p-0.5 justify-center"
              thumbClass="w-5 h-5 rounded-full bg-background checked:translate-x-4"
            />
          </View>

          <If when={feedback()}>
            {(msg) => (
              <View
                class={`rounded-xl border px-3 py-2 ${
                  msg().kind === "error"
                    ? "border-destructive/40 bg-destructive/10"
                    : msg().kind === "ok"
                      ? "border-emerald-500/40 bg-emerald-500/10"
                      : "border-border bg-muted"
                }`}
              >
                <Text
                  class={`text-xs ${
                    msg().kind === "error" ? "text-destructive" : "text-foreground"
                  }`}
                >
                  {msg().text}
                </Text>
              </View>
            )}
          </If>
        </Scroll>

        <View class="flex-row gap-2">
          <Button
            disabled={testing() || saving()}
            onPress={() => void handleTest()}
            class="flex-1 items-center rounded-xl border border-border bg-background py-3 active:bg-muted disabled:opacity-50"
          >
            <Text class="text-sm font-medium text-foreground">
              {testing() ? "测试中..." : "测试连接"}
            </Text>
          </Button>
          <Button
            disabled={saving() || testing()}
            onPress={() => void handleSubmit()}
            class="flex-1 items-center rounded-xl bg-primary py-3 active:opacity-85 disabled:opacity-50"
          >
            <Text class="text-sm font-semibold text-primary-foreground">
              {saving() ? "保存中..." : "保存账号"}
            </Text>
          </Button>
        </View>
      </View>
    </Sheet>
  );
}

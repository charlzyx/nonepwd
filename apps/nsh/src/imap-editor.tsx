import { View, batch, effect, signal } from "nsh";
import { Switch } from "nsh/base";
import { Haptics } from "nsh/mobile";
import {
  IMAP_PROVIDER_PRESETS,
  type ImapAccountPublic,
  type SaveImapAccountInput,
} from "./api";
import {
  ActionButton,
  AppInput,
  BodyText,
  FeedbackBanner,
  FilterPill,
  FormField,
  GroupedList,
  GroupedRow,
  SheetContainer,
} from "./ui";

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
    <SheetContainer
      open={props.open}
      onClose={() => props.onClose()}
      title={props.initialAccount ? "编辑 IMAP 邮箱" : "添加 IMAP 收信邮箱"}
      subtitle="支持同一服务商添加任意多个账号，互不限制"
      closeLabel="取消"
      footer={
        <View class="flex-row gap-2">
          <ActionButton
            variant="secondary"
            class="flex-1"
            label={testing() ? "测试中..." : "测试连接"}
            disabled={testing() || saving()}
            onPress={() => void handleTest()}
          />
          <ActionButton
            variant="primary"
            class="flex-1"
            label={saving() ? "保存中..." : "保存账号"}
            disabled={saving() || testing()}
            onPress={() => void handleSubmit()}
          />
        </View>
      }
    >
      {/* Provider Presets */}
      <FormField label="快速服务商预设">
        <View class="flex-row flex-wrap gap-2">
          <Each of={IMAP_PROVIDER_PRESETS}>
            {(preset) => (
              <FilterPill
                surface="card"
                label={preset().label}
                selected={Boolean(preset().host && host() === preset().host)}
                onPress={() => applyPreset(preset())}
              />
            )}
          </Each>
        </View>
      </FormField>

      <FormField label="账号备注名称">
        <AppInput
          value={label()}
          onChange={(e) => label.set(e.value)}
          placeholder="例如 工作 Gmail / 个人 QQ"
        />
      </FormField>

      <View class="flex-row gap-2">
        <FormField label="IMAP 服务器 (Host)" class="flex-1">
          <AppInput
            value={host()}
            onChange={(e) => host.set(e.value)}
            placeholder="imap.gmail.com"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </FormField>
        <FormField label="端口" class="w-24">
          <AppInput
            value={portText()}
            onChange={(e) => portText.set(e.value)}
            keyboardType="number-pad"
            placeholder="993"
          />
        </FormField>
      </View>

      <FormField label="邮箱账号">
        <AppInput
          value={username()}
          onChange={(e) => username.set(e.value)}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="you@gmail.com"
        />
      </FormField>

      <FormField
        label={
          props.initialAccount
            ? "应用专用密码 / 授权码 (留空保持不变)"
            : "应用专用密码 / 授权码"
        }
      >
        <AppInput
          value={password()}
          onChange={(e) => password.set(e.value)}
          masked
          placeholder={props.initialAccount?.hasPassword ? "已加密保存，留空则不修改" : "输入授权码"}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </FormField>

      <GroupedList surface="sheet">
        <GroupedRow class="flex-row items-center justify-between gap-3">
          <BodyText class="font-medium">使用 SSL/TLS 加密连接</BodyText>
          <Switch
            checked={tls()}
            onChange={(e) => tls.set(e.checked)}
            trackClass="w-10 h-6 rounded-full bg-muted checked:bg-primary p-0.5 justify-center"
            thumbClass="w-5 h-5 rounded-full bg-primary-foreground checked:translate-x-4"
          />
        </GroupedRow>
        <GroupedRow last class="flex-row items-center justify-between gap-3">
          <BodyText class="font-medium">启用此邮箱自动收信</BodyText>
          <Switch
            checked={enabled()}
            onChange={(e) => enabled.set(e.checked)}
            trackClass="w-10 h-6 rounded-full bg-muted checked:bg-primary p-0.5 justify-center"
            thumbClass="w-5 h-5 rounded-full bg-primary-foreground checked:translate-x-4"
          />
        </GroupedRow>
      </GroupedList>

      <If when={feedback()}>
        {(msg) => <FeedbackBanner kind={msg().kind} text={msg().text} />}
      </If>
    </SheetContainer>
  );
}

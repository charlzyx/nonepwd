import { Scroll, Text, View, batch, effect, signal } from "nsh";
import { Button, Input, Sheet, Switch } from "nsh/base";
import { Haptics } from "nsh/mobile";
import {
  generatePassword,
  randomId,
  type CardDetails,
  type CustomField,
  type DecryptedVault,
  type IdentityDetails,
  type ItemCategory,
  type TotpImportEntry,
  type VaultItemPayload,
} from "./crypto";

export const CATEGORY_OPTIONS: Array<{ key: ItemCategory; label: string }> = [
  { key: "login", label: "登录" },
  { key: "api_credential", label: "API 密钥" },
  { key: "ssh_key", label: "SSH 密钥" },
  { key: "card", label: "银行卡" },
  { key: "identity", label: "身份" },
  { key: "secure_note", label: "笔记" },
];

export interface ItemEditorSheetProps {
  open: boolean;
  initialItem: VaultItemPayload | null;
  vaults: DecryptedVault[];
  defaultVaultId: string;
  allTags: string[];
  onSave: (item: VaultItemPayload, isNew: boolean) => Promise<void>;
  onOpenQrForTotp: (onPicked: (entry: TotpImportEntry) => void) => void;
  onClose: () => void;
}

export function ItemEditorSheet(props: ItemEditorSheetProps) {
  const vaultId = signal("");
  const category = signal<ItemCategory>("login");
  const title = signal("");
  const username = signal("");
  const password = signal("");
  const urlsText = signal("");
  const totp = signal("");
  const emailAlias = signal("");
  const tagsText = signal("");
  const notes = signal("");
  const favorite = signal(false);

  // Password generator options
  const pwLength = signal(20);
  const pwSymbols = signal(true);

  // SSH fields
  const sshPublicKey = signal("");
  const sshPassphrase = signal("");

  // Card fields
  const cardHolder = signal("");
  const cardNumber = signal("");
  const cardExpMonth = signal("");
  const cardExpYear = signal("");
  const cardCvv = signal("");
  const cardBrand = signal("");

  // Identity fields
  const idFullName = signal("");
  const idEmail = signal("");
  const idPhone = signal("");
  const idCompany = signal("");
  const idAddress1 = signal("");
  const idCity = signal("");
  const idState = signal("");
  const idPostal = signal("");
  const idCountry = signal("");

  const customFields = signal<CustomField[]>([]);
  const saving = signal(false);
  const errorMsg = signal<string | null>(null);

  effect(() => {
    if (!props.open) return;
    const it = props.initialItem;
    batch(() => {
      errorMsg.set(null);
      saving.set(false);
      vaultId.set(
        it?.vaultId ??
          (props.defaultVaultId && props.defaultVaultId !== "all"
            ? props.defaultVaultId
            : props.vaults[0]?.id ?? "")
      );
      category.set(it?.category ?? "login");
      title.set(it?.title ?? "");
      username.set(it?.username ?? "");
      password.set(it?.password ?? "");
      urlsText.set(it?.urls.join("\n") ?? "");
      totp.set(it?.totp ?? "");
      emailAlias.set(it?.emailAlias ?? "");
      tagsText.set(it?.tags.join(", ") ?? "");
      notes.set(it?.notes ?? "");
      favorite.set(Boolean(it?.favorite));

      if (it?.category === "ssh_key") {
        sshPublicKey.set(
          it.customFields.find((f) => f.label.trim().toLowerCase() === "public_key")?.value ?? ""
        );
        sshPassphrase.set(
          it.customFields.find((f) => f.label.trim().toLowerCase() === "passphrase")?.value ?? ""
        );
        customFields.set(
          it.customFields.filter((f) => {
            const k = f.label.trim().toLowerCase();
            return k !== "public_key" && k !== "passphrase";
          })
        );
      } else {
        sshPublicKey.set("");
        sshPassphrase.set("");
        customFields.set(it?.customFields ? [...it.customFields] : []);
      }

      cardHolder.set(it?.card?.cardholderName ?? "");
      cardNumber.set(it?.card?.number ?? "");
      cardExpMonth.set(it?.card?.expMonth ?? "");
      cardExpYear.set(it?.card?.expYear ?? "");
      cardCvv.set(it?.card?.cvv ?? "");
      cardBrand.set(it?.card?.brand ?? "");

      idFullName.set(it?.identity?.fullName ?? "");
      idEmail.set(it?.identity?.email ?? "");
      idPhone.set(it?.identity?.phone ?? "");
      idCompany.set(it?.identity?.company ?? "");
      idAddress1.set(it?.identity?.address1 ?? "");
      idCity.set(it?.identity?.city ?? "");
      idState.set(it?.identity?.state ?? "");
      idPostal.set(it?.identity?.postalCode ?? "");
      idCountry.set(it?.identity?.country ?? "");
    });
  });

  function handleGeneratePassword() {
    const pw = generatePassword({
      length: pwLength(),
      uppercase: true,
      lowercase: true,
      digits: true,
      symbols: pwSymbols(),
    });
    password.set(pw);
    Haptics.impact("light");
  }

  function handleToggleTag(tag: string) {
    const current = tagsText()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const exists = current.some((t) => t.toLowerCase() === tag.toLowerCase());
    const next = exists
      ? current.filter((t) => t.toLowerCase() !== tag.toLowerCase())
      : [...current, tag];
    tagsText.set(next.join(", "));
  }

  function handleAddCustomField() {
    customFields.update((prev) => [
      ...prev,
      { id: randomId(), label: "", value: "", type: "concealed" },
    ]);
  }

  function handleUpdateCustomField(id: string, patch: Partial<CustomField>) {
    customFields.update((prev) =>
      prev.map((cf) => (cf.id === id ? { ...cf, ...patch } : cf))
    );
  }

  function handleRemoveCustomField(id: string) {
    customFields.update((prev) => prev.filter((cf) => cf.id !== id));
  }

  async function handleSubmit() {
    const trimmedTitle = title().trim();
    if (!trimmedTitle) {
      errorMsg.set("请填写条目标题");
      return;
    }
    const vid = vaultId() || props.vaults[0]?.id;
    if (!vid) {
      errorMsg.set("请先选择一个保险库");
      return;
    }

    const cat = category();
    const isNew = !props.initialItem;
    const now = new Date().toISOString();
    const urls = urlsText()
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const tags = Array.from(
      new Set(
        tagsText()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      )
    );

    const fields: CustomField[] = customFields()
      .filter((f) => f.label.trim() || f.value.trim())
      .map((f) => ({
        id: f.id || randomId(),
        label: f.label.trim() || "字段",
        value: f.value,
        type: f.type,
      }));

    if (cat === "ssh_key") {
      if (sshPublicKey().trim()) {
        fields.unshift({
          id: randomId(),
          label: "public_key",
          value: sshPublicKey().trim(),
          type: "text",
        });
      }
      if (sshPassphrase()) {
        fields.unshift({
          id: randomId(),
          label: "passphrase",
          value: sshPassphrase(),
          type: "concealed",
        });
      }
    }

    const cardObj: CardDetails = {
      ...(cardHolder().trim() ? { cardholderName: cardHolder().trim() } : {}),
      ...(cardNumber().trim() ? { number: cardNumber().trim() } : {}),
      ...(cardExpMonth().trim() ? { expMonth: cardExpMonth().trim() } : {}),
      ...(cardExpYear().trim() ? { expYear: cardExpYear().trim() } : {}),
      ...(cardCvv().trim() ? { cvv: cardCvv().trim() } : {}),
      ...(cardBrand().trim() ? { brand: cardBrand().trim() } : {}),
    };
    const hasCard = cat === "card" && Object.keys(cardObj).length > 0;

    const idObj: IdentityDetails = {
      ...(idFullName().trim() ? { fullName: idFullName().trim() } : {}),
      ...(idEmail().trim() ? { email: idEmail().trim() } : {}),
      ...(idPhone().trim() ? { phone: idPhone().trim() } : {}),
      ...(idCompany().trim() ? { company: idCompany().trim() } : {}),
      ...(idAddress1().trim() ? { address1: idAddress1().trim() } : {}),
      ...(idCity().trim() ? { city: idCity().trim() } : {}),
      ...(idState().trim() ? { state: idState().trim() } : {}),
      ...(idPostal().trim() ? { postalCode: idPostal().trim() } : {}),
      ...(idCountry().trim() ? { country: idCountry().trim() } : {}),
    };
    const hasId = cat === "identity" && Object.keys(idObj).length > 0;

    const payload: VaultItemPayload = {
      id: props.initialItem?.id ?? randomId(),
      vaultId: vid,
      category: cat,
      title: trimmedTitle,
      favorite: favorite(),
      tags,
      urls,
      ...(username().trim() ? { username: username().trim() } : {}),
      ...(password() ? { password: password() } : {}),
      ...(totp().trim() ? { totp: totp().trim() } : {}),
      ...(emailAlias().trim() ? { emailAlias: emailAlias().trim() } : {}),
      ...(notes().trim() ? { notes: notes().trim() } : {}),
      ...(hasCard ? { card: cardObj } : {}),
      ...(hasId ? { identity: idObj } : {}),
      customFields: fields,
      createdAt: props.initialItem?.createdAt ?? now,
      updatedAt: now,
      ...(props.initialItem?.lastUsedAt ? { lastUsedAt: props.initialItem.lastUsedAt } : {}),
    };

    saving.set(true);
    errorMsg.set(null);
    try {
      await props.onSave(payload, isNew);
      Haptics.notification("success");
      props.onClose();
    } catch (err) {
      errorMsg.set(err instanceof Error ? err.message : "保存条目失败");
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
      popupClass="bg-card rounded-t-2xl border-t border-border p-4 pb-[calc(env(safe-area-inset-bottom)+16px)] max-h-[92%]"
      backdropClass="bg-black/45"
    >
      <View class="gap-3">
        {/* Header */}
        <View class="flex-row items-center justify-between">
          <Text class="text-lg font-semibold text-foreground">
            {props.initialItem ? "编辑条目" : "新建条目"}
          </Text>
          <Button
            onPress={props.onClose}
            class="rounded-full bg-muted px-3 py-1.5 active:opacity-75"
          >
            <Text class="text-xs font-medium text-foreground">取消</Text>
          </Button>
        </View>

        <Scroll class="max-h-[460px]" contentClass="gap-3 pb-2">
          {/* Vault Selector */}
          <If when={!props.initialItem && props.vaults.length > 0}>
            <View class="gap-1.5">
              <Text class="text-xs font-medium text-muted-foreground">所属保险库</Text>
              <View class="flex-row flex-wrap gap-1.5">
                <Each of={props.vaults}>
                  {(v) => (
                    <Button
                      onPress={() => vaultId.set(v().id)}
                      class={`rounded-full border px-3 py-1.5 ${
                        vaultId() === v().id
                          ? "border-primary bg-primary"
                          : "border-border bg-background"
                      }`}
                    >
                      <Text
                        class={`text-xs font-medium ${
                          vaultId() === v().id
                            ? "text-primary-foreground"
                            : "text-foreground"
                        }`}
                      >
                        {v().metadata.name}
                      </Text>
                    </Button>
                  )}
                </Each>
              </View>
            </View>
          </If>

          {/* Category Selector */}
          <View class="gap-1.5">
            <Text class="text-xs font-medium text-muted-foreground">条目类型</Text>
            <View class="flex-row flex-wrap gap-1.5">
              <Each of={CATEGORY_OPTIONS}>
                {(opt) => (
                  <Button
                    onPress={() => category.set(opt().key)}
                    class={`rounded-full border px-3 py-1.5 ${
                      category() === opt().key
                        ? "border-primary bg-primary"
                        : "border-border bg-background"
                    }`}
                  >
                    <Text
                      class={`text-xs font-medium ${
                        category() === opt().key
                          ? "text-primary-foreground"
                          : "text-foreground"
                      }`}
                    >
                      {opt().label}
                    </Text>
                  </Button>
                )}
              </Each>
            </View>
          </View>

          {/* Title */}
          <View class="gap-1">
            <Text class="text-xs font-medium text-muted-foreground">标题</Text>
            <Input
              testID="item-title-input"
              value={title()}
              onChange={(e) => title.set(e.value)}
              placeholder="例如 GitHub、OpenAI API、个人银行卡"
              class="rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground"
            />
          </View>

          {/* Credential Fields */}
          <If when={category() !== "card" && category() !== "identity"}>
            <View class="gap-3">
              <If when={category() !== "secure_note"}>
                <View class="gap-1">
                  <Text class="text-xs font-medium text-muted-foreground">
                    {category() === "api_credential" ? "凭证标识 / Key ID" : "用户名 / 邮箱"}
                  </Text>
                  <Input
                    value={username()}
                    onChange={(e) => username.set(e.value)}
                    placeholder="user@example.com"
                    autoCapitalize="none"
                    autoCorrect={false}
                    class="rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground"
                  />
                </View>
              </If>

              <View class="gap-1.5">
                <View class="flex-row items-center justify-between">
                  <Text class="text-xs font-medium text-muted-foreground">
                    {category() === "api_credential"
                      ? "API Key / Secret"
                      : category() === "ssh_key"
                        ? "SSH 私钥 (Private Key)"
                        : category() === "secure_note"
                          ? "机密内容"
                          : "密码"}
                  </Text>
                  <If when={category() === "login" || category() === "api_credential"}>
                    <Button
                      onPress={handleGeneratePassword}
                      class="rounded-lg bg-muted px-2.5 py-1 active:opacity-75"
                    >
                      <Text class="text-xs font-medium text-foreground">生成强密码</Text>
                    </Button>
                  </If>
                </View>
                <Input
                  value={password()}
                  onChange={(e) => password.set(e.value)}
                  multiline={category() === "ssh_key" || category() === "secure_note"}
                  placeholder={
                    category() === "ssh_key" ? "-----BEGIN OPENSSH PRIVATE KEY-----" : "输入密码或密钥"
                  }
                  autoCapitalize="none"
                  autoCorrect={false}
                  class={`rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground ${
                    category() === "ssh_key" || category() === "secure_note" ? "h-24" : ""
                  }`}
                />
                <If when={category() === "login"}>
                  <View class="flex-row items-center justify-between rounded-xl border border-border bg-background px-3 py-2">
                    <View class="flex-row items-center gap-1.5">
                      <Text class="text-[11px] text-muted-foreground">长度:</Text>
                      <Each of={[12, 16, 20, 28]}>
                        {(len) => (
                          <Button
                            onPress={() => pwLength.set(len())}
                            class={`rounded-md px-2 py-0.5 ${
                              pwLength() === len() ? "bg-primary" : "bg-muted"
                            }`}
                          >
                            <Text
                              class={`text-[11px] font-medium ${
                                pwLength() === len()
                                  ? "text-primary-foreground"
                                  : "text-foreground"
                              }`}
                            >
                              {len()}
                            </Text>
                          </Button>
                        )}
                      </Each>
                    </View>
                    <Switch
                      checked={pwSymbols()}
                      onChange={(e) => pwSymbols.set(e.checked)}
                      class="flex-row items-center gap-1.5"
                      trackClass="w-9 h-5 rounded-full bg-muted checked:bg-primary p-0.5 justify-center"
                      thumbClass="w-4 h-4 rounded-full bg-background checked:translate-x-4"
                    >
                      <Text class="text-[11px] text-muted-foreground">符号</Text>
                    </Switch>
                  </View>
                </If>
              </View>

              <If when={category() === "ssh_key"}>
                <View class="gap-2">
                  <View class="gap-1">
                    <Text class="text-xs font-medium text-muted-foreground">SSH 公钥 (public_key)</Text>
                    <Input
                      value={sshPublicKey()}
                      onChange={(e) => sshPublicKey.set(e.value)}
                      placeholder="ssh-ed25519 AAAA..."
                      autoCapitalize="none"
                      autoCorrect={false}
                      class="rounded-xl border border-input bg-background px-3 py-2 text-xs text-foreground"
                    />
                  </View>
                  <View class="gap-1">
                    <Text class="text-xs font-medium text-muted-foreground">私钥口令 (passphrase)</Text>
                    <Input
                      value={sshPassphrase()}
                      onChange={(e) => sshPassphrase.set(e.value)}
                      masked
                      placeholder="可选"
                      class="rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground"
                    />
                  </View>
                </View>
              </If>

              <If when={category() !== "ssh_key" && category() !== "secure_note"}>
                <View class="gap-1.5">
                  <View class="flex-row items-center justify-between">
                    <Text class="text-xs font-medium text-muted-foreground">2FA / TOTP 密钥</Text>
                    <Button
                      onPress={() =>
                        props.onOpenQrForTotp((entry) => {
                          totp.set(entry.otpauthUri);
                          if (!title().trim() && (entry.issuer || entry.account)) {
                            title.set(entry.issuer || entry.account || "");
                          }
                          if (!username().trim() && entry.account) {
                            username.set(entry.account);
                          }
                        })
                      }
                      class="rounded-lg bg-muted px-2.5 py-1 active:opacity-75"
                    >
                      <Text class="text-xs font-medium text-foreground">扫码 / 选图识别 2FA</Text>
                    </Button>
                  </View>
                  <Input
                    value={totp()}
                    onChange={(e) => totp.set(e.value)}
                    placeholder="otpauth://totp/... 或 Base32 密钥"
                    autoCapitalize="none"
                    autoCorrect={false}
                    class="rounded-xl border border-input bg-background px-3 py-2 text-xs text-foreground"
                  />
                </View>
              </If>

              <View class="gap-1">
                <Text class="text-xs font-medium text-muted-foreground">
                  {category() === "api_credential" ? "Endpoint URL" : "关联网址 (每行一个)"}
                </Text>
                <Input
                  value={urlsText()}
                  onChange={(e) => urlsText.set(e.value)}
                  multiline
                  placeholder="https://github.com"
                  autoCapitalize="none"
                  autoCorrect={false}
                  class="h-16 rounded-xl border border-input bg-background p-2.5 text-xs text-foreground"
                />
              </View>
            </View>
          </If>

          {/* Card Fields */}
          <If when={category() === "card"}>
            <View class="gap-2.5">
              <View class="gap-1">
                <Text class="text-xs font-medium text-muted-foreground">持卡人姓名</Text>
                <Input
                  value={cardHolder()}
                  onChange={(e) => cardHolder.set(e.value)}
                  placeholder="Alice Chen"
                  class="rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground"
                />
              </View>
              <View class="gap-1">
                <Text class="text-xs font-medium text-muted-foreground">卡号</Text>
                <Input
                  value={cardNumber()}
                  onChange={(e) => cardNumber.set(e.value)}
                  keyboardType="number-pad"
                  placeholder="4242 4242 4242 4242"
                  class="rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground"
                />
              </View>
              <View class="flex-row gap-2">
                <View class="flex-1 gap-1">
                  <Text class="text-xs font-medium text-muted-foreground">月</Text>
                  <Input
                    value={cardExpMonth()}
                    onChange={(e) => cardExpMonth.set(e.value)}
                    keyboardType="number-pad"
                    placeholder="09"
                    class="rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground"
                  />
                </View>
                <View class="flex-1 gap-1">
                  <Text class="text-xs font-medium text-muted-foreground">年</Text>
                  <Input
                    value={cardExpYear()}
                    onChange={(e) => cardExpYear.set(e.value)}
                    keyboardType="number-pad"
                    placeholder="2029"
                    class="rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground"
                  />
                </View>
                <View class="flex-1 gap-1">
                  <Text class="text-xs font-medium text-muted-foreground">CVV</Text>
                  <Input
                    value={cardCvv()}
                    onChange={(e) => cardCvv.set(e.value)}
                    keyboardType="number-pad"
                    placeholder="123"
                    class="rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground"
                  />
                </View>
              </View>
              <View class="gap-1">
                <Text class="text-xs font-medium text-muted-foreground">卡组织 / 银行</Text>
                <Input
                  value={cardBrand()}
                  onChange={(e) => cardBrand.set(e.value)}
                  placeholder="Visa / Mastercard / 银联"
                  class="rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground"
                />
              </View>
            </View>
          </If>

          {/* Identity Fields */}
          <If when={category() === "identity"}>
            <View class="gap-2.5">
              <View class="gap-1">
                <Text class="text-xs font-medium text-muted-foreground">姓名</Text>
                <Input
                  value={idFullName()}
                  onChange={(e) => idFullName.set(e.value)}
                  placeholder="姓名"
                  class="rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground"
                />
              </View>
              <View class="flex-row gap-2">
                <View class="flex-1 gap-1">
                  <Text class="text-xs font-medium text-muted-foreground">邮箱</Text>
                  <Input
                    value={idEmail()}
                    onChange={(e) => idEmail.set(e.value)}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    placeholder="alice@example.com"
                    class="rounded-xl border border-input bg-background px-3 py-2 text-xs text-foreground"
                  />
                </View>
                <View class="flex-1 gap-1">
                  <Text class="text-xs font-medium text-muted-foreground">电话</Text>
                  <Input
                    value={idPhone()}
                    onChange={(e) => idPhone.set(e.value)}
                    keyboardType="phone-pad"
                    placeholder="+86 138..."
                    class="rounded-xl border border-input bg-background px-3 py-2 text-xs text-foreground"
                  />
                </View>
              </View>
              <View class="gap-1">
                <Text class="text-xs font-medium text-muted-foreground">街道地址</Text>
                <Input
                  value={idAddress1()}
                  onChange={(e) => idAddress1.set(e.value)}
                  placeholder="详细地址"
                  class="rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground"
                />
              </View>
              <View class="flex-row gap-2">
                <View class="flex-1 gap-1">
                  <Text class="text-xs font-medium text-muted-foreground">城市</Text>
                  <Input
                    value={idCity()}
                    onChange={(e) => idCity.set(e.value)}
                    placeholder="城市"
                    class="rounded-xl border border-input bg-background px-3 py-2 text-xs text-foreground"
                  />
                </View>
                <View class="flex-1 gap-1">
                  <Text class="text-xs font-medium text-muted-foreground">省/州</Text>
                  <Input
                    value={idState()}
                    onChange={(e) => idState.set(e.value)}
                    placeholder="省/州"
                    class="rounded-xl border border-input bg-background px-3 py-2 text-xs text-foreground"
                  />
                </View>
                <View class="flex-1 gap-1">
                  <Text class="text-xs font-medium text-muted-foreground">邮编</Text>
                  <Input
                    value={idPostal()}
                    onChange={(e) => idPostal.set(e.value)}
                    placeholder="邮编"
                    class="rounded-xl border border-input bg-background px-3 py-2 text-xs text-foreground"
                  />
                </View>
              </View>
              <View class="flex-row gap-2">
                <View class="flex-1 gap-1">
                  <Text class="text-xs font-medium text-muted-foreground">国家/地区</Text>
                  <Input
                    value={idCountry()}
                    onChange={(e) => idCountry.set(e.value)}
                    placeholder="CN / US"
                    class="rounded-xl border border-input bg-background px-3 py-2 text-xs text-foreground"
                  />
                </View>
                <View class="flex-1 gap-1">
                  <Text class="text-xs font-medium text-muted-foreground">公司</Text>
                  <Input
                    value={idCompany()}
                    onChange={(e) => idCompany.set(e.value)}
                    placeholder="可选"
                    class="rounded-xl border border-input bg-background px-3 py-2 text-xs text-foreground"
                  />
                </View>
              </View>
            </View>
          </If>

          {/* Tags / Groups */}
          <View class="gap-1.5">
            <Text class="text-xs font-medium text-muted-foreground">分组标签 (逗号分隔)</Text>
            <Input
              value={tagsText()}
              onChange={(e) => tagsText.set(e.value)}
              placeholder="工作, 开发, 财务"
              class="rounded-xl border border-input bg-background px-3 py-2 text-xs text-foreground"
            />
            <If when={props.allTags.length > 0}>
              <View class="flex-row flex-wrap gap-1.5">
                <Each of={props.allTags}>
                  {(tag) => (
                    <Button
                      onPress={() => handleToggleTag(tag())}
                      class="rounded-full border border-border bg-background px-2.5 py-1 active:bg-muted"
                    >
                      <Text class="text-[11px] text-foreground">#{tag()}</Text>
                    </Button>
                  )}
                </Each>
              </View>
            </If>
          </View>

          {/* Notes */}
          <View class="gap-1">
            <Text class="text-xs font-medium text-muted-foreground">备注</Text>
            <Input
              value={notes()}
              onChange={(e) => notes.set(e.value)}
              multiline
              placeholder="补充说明、恢复码等"
              class="h-20 rounded-xl border border-input bg-background p-2.5 text-xs text-foreground"
            />
          </View>

          {/* Custom Fields */}
          <View class="gap-2">
            <View class="flex-row items-center justify-between">
              <Text class="text-xs font-medium text-muted-foreground">
                自定义字段 ({customFields().length})
              </Text>
              <Button
                onPress={handleAddCustomField}
                class="rounded-lg border border-border bg-background px-2.5 py-1 active:bg-muted"
              >
                <Text class="text-xs font-medium text-foreground">+ 添加字段</Text>
              </Button>
            </View>
            <Each of={customFields()} key={(f) => f.id}>
              {(cf) => (
                <View class="gap-1.5 rounded-xl border border-border bg-background p-2.5">
                  <View class="flex-row items-center gap-2">
                    <Input
                      value={cf().label}
                      onChange={(e) => handleUpdateCustomField(cf().id, { label: e.value })}
                      placeholder="字段名 (如 Recovery Code)"
                      class="flex-1 rounded-lg border border-input bg-card px-2.5 py-1.5 text-xs text-foreground"
                    />
                    <Button
                      onPress={() =>
                        handleUpdateCustomField(cf().id, {
                          type: cf().type === "concealed" ? "text" : "concealed",
                        })
                      }
                      class="rounded-lg bg-muted px-2 py-1.5"
                    >
                      <Text class="text-[11px] text-foreground">
                        {cf().type === "concealed" ? "隐藏" : "明文"}
                      </Text>
                    </Button>
                    <Button
                      onPress={() => handleRemoveCustomField(cf().id)}
                      class="rounded-lg bg-destructive/10 px-2 py-1.5"
                    >
                      <Text class="text-[11px] text-destructive">删</Text>
                    </Button>
                  </View>
                  <Input
                    value={cf().value}
                    onChange={(e) => handleUpdateCustomField(cf().id, { value: e.value })}
                    placeholder="字段值"
                    class="rounded-lg border border-input bg-card px-2.5 py-1.5 text-xs text-foreground"
                  />
                </View>
              )}
            </Each>
          </View>

          <View class="flex-row items-center justify-between rounded-xl border border-border bg-background px-3 py-2.5">
            <Text class="text-xs font-medium text-foreground">标记为收藏</Text>
            <Switch
              checked={favorite()}
              onChange={(e) => favorite.set(e.checked)}
              trackClass="w-10 h-6 rounded-full bg-muted checked:bg-primary p-0.5 justify-center"
              thumbClass="w-5 h-5 rounded-full bg-background checked:translate-x-4"
            />
          </View>

          <If when={errorMsg()}>
            {(msg) => (
              <View class="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2">
                <Text class="text-xs text-destructive">{msg()}</Text>
              </View>
            )}
          </If>
        </Scroll>

        <Button
          disabled={saving()}
          onPress={() => void handleSubmit()}
          class="items-center rounded-xl bg-primary py-3 active:opacity-85 disabled:opacity-50"
        >
          <Text class="text-sm font-semibold text-primary-foreground">
            {saving() ? "正在加密保存..." : "加密并保存"}
          </Text>
        </Button>
      </View>
    </Sheet>
  );
}

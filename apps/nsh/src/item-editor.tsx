import { Text, View, batch, effect, signal } from "nsh";
import { Button, Switch } from "nsh/base";
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
import qrcodeIcon from "./icons/qrcode.svg";
import {
  ActionButton,
  AppInput,
  AppSelect,
  BodyText,
  CompactButton,
  FeedbackBanner,
  FilterPill,
  FormField,
  GroupedList,
  GroupedRow,
  SectionHeader,
  SheetContainer,
  SubheadText,
} from "./ui";

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

  function hasTagSelected(tag: string): boolean {
    const target = tag.toLowerCase();
    return tagsText()
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .includes(target);
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
    <SheetContainer
      open={props.open}
      onClose={() => props.onClose()}
      title={props.initialItem ? "编辑条目" : "新建条目"}
      closeLabel="取消"
      footer={
        <ActionButton
          label={saving() ? "正在加密保存..." : "加密并保存"}
          disabled={saving()}
          onPress={() => void handleSubmit()}
        />
      }
    >
      {/* Vault Selector using official Select when multiple vaults exist */}
      <If when={!props.initialItem && props.vaults.length > 1}>
        <FormField label="所属保险库">
          <AppSelect
            surface="card"
            accessibilityLabel="选择所属保险库"
            items={props.vaults.map((v) => ({
              value: v.id,
              title: v.metadata.name,
            }))}
            value={vaultId()}
            onChange={(val) => vaultId.set(val)}
          />
        </FormField>
      </If>

      {/* Category Selector */}
      <FormField label="条目类型">
        <View class="flex-row flex-wrap gap-2">
          <Each of={CATEGORY_OPTIONS}>
            {(opt) => (
              <FilterPill
                surface="card"
                label={opt().label}
                selected={category() === opt().key}
                onPress={() => category.set(opt().key)}
              />
            )}
          </Each>
        </View>
      </FormField>

      {/* Title */}
      <FormField label="标题">
        <AppInput
          testID="item-title-input"
          value={title()}
          onChange={(e) => title.set(e.value)}
          placeholder="例如 GitHub、OpenAI API、个人银行卡"
        />
      </FormField>

      {/* Credential Fields */}
      <If when={category() !== "card" && category() !== "identity"}>
        <View class="gap-4">
          <If when={category() !== "secure_note"}>
            <FormField
              label={category() === "api_credential" ? "凭证标识 / Key ID" : "用户名 / 邮箱"}
            >
              <AppInput
                value={username()}
                onChange={(e) => username.set(e.value)}
                placeholder="user@example.com"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </FormField>
          </If>

          <FormField
            label={
              category() === "api_credential"
                ? "API Key / Secret"
                : category() === "ssh_key"
                  ? "SSH 私钥 (Private Key)"
                  : category() === "secure_note"
                    ? "机密内容"
                    : "密码"
            }
            rightSlot={
              <If when={category() === "login" || category() === "api_credential"}>
                <CompactButton
                  label="生成强密码"
                  variant="tonal"
                  onPress={handleGeneratePassword}
                />
              </If>
            }
          >
            <AppInput
              value={password()}
              onChange={(e) => password.set(e.value)}
              multiline={category() === "ssh_key" || category() === "secure_note"}
              mono={category() === "ssh_key"}
              placeholder={
                category() === "ssh_key" ? "-----BEGIN OPENSSH PRIVATE KEY-----" : "输入密码或密钥"
              }
              autoCapitalize="none"
              autoCorrect={false}
            />
            <If when={category() === "login"}>
              <GroupedList surface="sheet">
                <GroupedRow last class="flex-row items-center justify-between py-2">
                  <View class="flex-row items-center gap-2">
                    <SubheadText>长度</SubheadText>
                    <Each of={[12, 16, 20, 28]}>
                      {(len) => (
                        <Button
                          onPress={() => {
                            Haptics.selection();
                            pwLength.set(len());
                          }}
                          class={`h-8 rounded-lg px-2 items-center justify-center ${
                            pwLength() === len() ? "bg-primary" : "bg-card"
                          }`}
                        >
                          <Text
                            class={`text-[13px] font-semibold ${
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
                    class="flex-row items-center gap-2"
                    trackClass="w-10 h-6 rounded-full bg-muted checked:bg-primary p-0.5 justify-center"
                    thumbClass="w-5 h-5 rounded-full bg-primary-foreground checked:translate-x-4"
                  >
                    <SubheadText>符号</SubheadText>
                  </Switch>
                </GroupedRow>
              </GroupedList>
            </If>
          </FormField>

          <If when={category() === "ssh_key"}>
            <View class="gap-3">
              <FormField label="SSH 公钥 (public_key)">
                <AppInput
                  mono
                  value={sshPublicKey()}
                  onChange={(e) => sshPublicKey.set(e.value)}
                  placeholder="ssh-ed25519 AAAA..."
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </FormField>
              <FormField label="私钥口令 (passphrase)">
                <AppInput
                  value={sshPassphrase()}
                  onChange={(e) => sshPassphrase.set(e.value)}
                  masked
                  placeholder="可选"
                />
              </FormField>
            </View>
          </If>

          <If when={category() !== "ssh_key" && category() !== "secure_note"}>
            <FormField
              label="2FA / TOTP 密钥"
              rightSlot={
                <CompactButton
                  label="扫码识别 2FA"
                  icon={qrcodeIcon}
                  variant="tonal"
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
                />
              }
            >
              <AppInput
                mono
                value={totp()}
                onChange={(e) => totp.set(e.value)}
                placeholder="otpauth://totp/... 或 Base32 密钥"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </FormField>
          </If>

          <FormField label={category() === "api_credential" ? "Endpoint URL" : "关联网址 (每行一个)"}>
            <AppInput
              multiline
              value={urlsText()}
              onChange={(e) => urlsText.set(e.value)}
              placeholder="https://github.com"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </FormField>
        </View>
      </If>

      {/* Card Fields */}
      <If when={category() === "card"}>
        <View class="gap-3">
          <FormField label="持卡人姓名">
            <AppInput
              value={cardHolder()}
              onChange={(e) => cardHolder.set(e.value)}
              placeholder="Alice Chen"
            />
          </FormField>
          <FormField label="卡号">
            <AppInput
              value={cardNumber()}
              onChange={(e) => cardNumber.set(e.value)}
              keyboardType="number-pad"
              placeholder="4242 4242 4242 4242"
            />
          </FormField>
          <View class="flex-row gap-2">
            <FormField label="月" class="flex-1">
              <AppInput
                value={cardExpMonth()}
                onChange={(e) => cardExpMonth.set(e.value)}
                keyboardType="number-pad"
                placeholder="09"
              />
            </FormField>
            <FormField label="年" class="flex-1">
              <AppInput
                value={cardExpYear()}
                onChange={(e) => cardExpYear.set(e.value)}
                keyboardType="number-pad"
                placeholder="2029"
              />
            </FormField>
            <FormField label="CVV" class="flex-1">
              <AppInput
                value={cardCvv()}
                onChange={(e) => cardCvv.set(e.value)}
                keyboardType="number-pad"
                placeholder="123"
              />
            </FormField>
          </View>
          <FormField label="卡组织 / 银行">
            <AppInput
              value={cardBrand()}
              onChange={(e) => cardBrand.set(e.value)}
              placeholder="Visa / Mastercard / 银联"
            />
          </FormField>
        </View>
      </If>

      {/* Identity Fields */}
      <If when={category() === "identity"}>
        <View class="gap-3">
          <FormField label="姓名">
            <AppInput
              value={idFullName()}
              onChange={(e) => idFullName.set(e.value)}
              placeholder="姓名"
            />
          </FormField>
          <View class="flex-row gap-2">
            <FormField label="邮箱" class="flex-1">
              <AppInput
                value={idEmail()}
                onChange={(e) => idEmail.set(e.value)}
                keyboardType="email-address"
                autoCapitalize="none"
                placeholder="alice@example.com"
              />
            </FormField>
            <FormField label="电话" class="flex-1">
              <AppInput
                value={idPhone()}
                onChange={(e) => idPhone.set(e.value)}
                keyboardType="phone-pad"
                placeholder="+86 138..."
              />
            </FormField>
          </View>
          <FormField label="街道地址">
            <AppInput
              value={idAddress1()}
              onChange={(e) => idAddress1.set(e.value)}
              placeholder="详细地址"
            />
          </FormField>
          <View class="flex-row gap-2">
            <FormField label="城市" class="flex-1">
              <AppInput
                value={idCity()}
                onChange={(e) => idCity.set(e.value)}
                placeholder="城市"
              />
            </FormField>
            <FormField label="省/州" class="flex-1">
              <AppInput
                value={idState()}
                onChange={(e) => idState.set(e.value)}
                placeholder="省/州"
              />
            </FormField>
            <FormField label="邮编" class="flex-1">
              <AppInput
                value={idPostal()}
                onChange={(e) => idPostal.set(e.value)}
                placeholder="邮编"
              />
            </FormField>
          </View>
          <View class="flex-row gap-2">
            <FormField label="国家/地区" class="flex-1">
              <AppInput
                value={idCountry()}
                onChange={(e) => idCountry.set(e.value)}
                placeholder="CN / US"
              />
            </FormField>
            <FormField label="公司" class="flex-1">
              <AppInput
                value={idCompany()}
                onChange={(e) => idCompany.set(e.value)}
                placeholder="可选"
              />
            </FormField>
          </View>
        </View>
      </If>

      {/* Tags / Groups */}
      <FormField label="分组标签 (逗号分隔)">
        <AppInput
          value={tagsText()}
          onChange={(e) => tagsText.set(e.value)}
          placeholder="工作, 开发, 财务"
        />
        <If when={props.allTags.length > 0}>
          <View class="flex-row flex-wrap gap-2 pt-1">
            <Each of={props.allTags}>
              {(tag) => (
                <FilterPill
                  surface="card"
                  label={`#${tag()}`}
                  selected={hasTagSelected(tag())}
                  onPress={() => handleToggleTag(tag())}
                />
              )}
            </Each>
          </View>
        </If>
      </FormField>

      {/* Notes */}
      <FormField label="备注">
        <AppInput
          multiline
          value={notes()}
          onChange={(e) => notes.set(e.value)}
          placeholder="补充说明、恢复码等"
        />
      </FormField>

      {/* Custom Fields */}
      <View class="gap-2">
        <SectionHeader
          title={`自定义字段 (${customFields().length})`}
          rightSlot={
            <CompactButton
              label="+ 添加字段"
              variant="tonal"
              onPress={handleAddCustomField}
            />
          }
        />
        <If when={customFields().length > 0}>
          <GroupedList surface="sheet">
            <Each of={customFields()} key={(f) => f.id}>
              {(cf, idx) => (
                <GroupedRow
                  last={idx() === customFields().length - 1}
                  class="gap-2"
                >
                  <View class="flex-row items-center gap-2">
                    <AppInput
                      surface="canvas"
                      class="flex-1"
                      value={cf().label}
                      onChange={(e) => handleUpdateCustomField(cf().id, { label: e.value })}
                      placeholder="字段名 (如 Recovery Code)"
                    />
                    <CompactButton
                      label={cf().type === "concealed" ? "隐藏" : "明文"}
                      variant="card"
                      onPress={() =>
                        handleUpdateCustomField(cf().id, {
                          type: cf().type === "concealed" ? "text" : "concealed",
                        })
                      }
                    />
                    <CompactButton
                      label="删"
                      variant="danger"
                      onPress={() => handleRemoveCustomField(cf().id)}
                    />
                  </View>
                  <AppInput
                    surface="canvas"
                    value={cf().value}
                    onChange={(e) => handleUpdateCustomField(cf().id, { value: e.value })}
                    placeholder="字段值"
                  />
                </GroupedRow>
              )}
            </Each>
          </GroupedList>
        </If>
      </View>

      <GroupedList surface="sheet">
        <GroupedRow last class="flex-row items-center justify-between">
          <BodyText class="font-medium">标记为收藏</BodyText>
          <Switch
            checked={favorite()}
            onChange={(e) => favorite.set(e.checked)}
            trackClass="w-10 h-6 rounded-full bg-muted checked:bg-primary p-0.5 justify-center"
            thumbClass="w-5 h-5 rounded-full bg-primary-foreground checked:translate-x-4"
          />
        </GroupedRow>
      </GroupedList>

      <If when={errorMsg()}>
        {(msg) => <FeedbackBanner kind="error" text={msg()} />}
      </If>
    </SheetContainer>
  );
}

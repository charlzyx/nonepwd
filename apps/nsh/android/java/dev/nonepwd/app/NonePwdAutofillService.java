package dev.nonepwd.app;

import android.app.PendingIntent;
import android.app.assist.AssistStructure;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.service.autofill.AutofillService;
import android.service.autofill.Dataset;
import android.service.autofill.FillCallback;
import android.service.autofill.FillContext;
import android.service.autofill.FillRequest;
import android.service.autofill.FillResponse;
import android.service.autofill.SaveCallback;
import android.service.autofill.SaveInfo;
import android.service.autofill.SaveRequest;
import android.text.InputType;
import android.util.Pair;
import android.view.View;
import android.view.ViewStructure;
import android.view.autofill.AutofillId;
import android.view.autofill.AutofillValue;
import android.widget.RemoteViews;
import com.longbridge.nsh.NonePwdHostActivity;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** Android System AutofillService (API 26+) backed by Keystore-encrypted AutofillStore. */
public final class NonePwdAutofillService extends AutofillService {
  private static final int MAX_DATASETS = 15;

  private static final Set<String> TRUSTED_BROWSER_PACKAGES =
      new HashSet<>(
          Arrays.asList(
              "com.android.chrome",
              "com.chrome.beta",
              "com.chrome.dev",
              "com.chrome.canary",
              "org.mozilla.firefox",
              "org.mozilla.firefox_beta",
              "org.mozilla.fenix",
              "org.mozilla.focus",
              "com.brave.browser",
              "com.microsoft.emmx",
              "com.opera.browser",
              "com.opera.mini.native",
              "com.sec.android.app.sbrowser",
              "com.vivaldi.browser",
              "com.kiwibrowser.browser",
              "com.duckduckgo.mobile.android",
              "mark.via.gp",
              "com.UCMobile.intl",
              "com.tencent.mtt"));

  private static final Set<String> MULTI_PART_SUFFIXES =
      new HashSet<>(
          Arrays.asList(
              "co.uk", "org.uk", "ac.uk", "gov.uk",
              "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
              "com.au", "net.au", "org.au",
              "co.jp", "ne.jp", "or.jp",
              "com.tw", "com.hk", "co.kr", "com.br", "com.sg", "co.in", "com.mx", "co.nz", "co.za",
              "github.io", "gitlab.io", "workers.dev", "pages.dev",
              "vercel.app", "netlify.app", "herokuapp.com", "fly.dev",
              "appspot.com", "azurewebsites.net", "cloudfront.net",
              "firebaseapp.com", "web.app", "onrender.com", "railway.app",
              "deno.dev", "surge.sh", "replit.dev"));

  private static final Set<String> IGNORED_PKG_TOKENS =
      new HashSet<>(
          Arrays.asList(
              "com", "org", "net", "io", "dev", "app", "android", "client", "mobile", "lite",
              "pro", "main", "ui", "auth", "login", "browser", "webview", "chrome", "firefox",
              "mozilla", "emmx", "brave", "opera", "vivaldi", "sbrowser", "beta"));

  static final class ParsedForm {
    String webDomain = "";
    String packageName = "";
    AutofillId usernameId;
    AutofillId passwordId;
    AutofillId otpId;
    AutofillId fallbackTextId;
    String usernameText = "";
    String passwordText = "";

    boolean hasAnyTarget() {
      return usernameId != null || passwordId != null || otpId != null;
    }

    AutofillId[] targetIds() {
      List<AutofillId> ids = new ArrayList<>(3);
      if (usernameId != null) {
        ids.add(usernameId);
      }
      if (passwordId != null) {
        ids.add(passwordId);
      }
      if (otpId != null) {
        ids.add(otpId);
      }
      return ids.toArray(new AutofillId[0]);
    }
  }

  private static final class ScoredCredential {
    final AutofillStore.Credential credential;
    final int score;

    ScoredCredential(AutofillStore.Credential credential, int score) {
      this.credential = credential;
      this.score = score;
    }
  }

  @Override
  public void onFillRequest(
      FillRequest request, CancellationSignal cancellationSignal, FillCallback callback) {
    if (cancellationSignal != null && cancellationSignal.isCanceled()) {
      return;
    }
    List<FillContext> contexts = request.getFillContexts();
    if (contexts == null || contexts.isEmpty()) {
      callback.onSuccess(null);
      return;
    }
    AssistStructure structure = contexts.get(contexts.size() - 1).getStructure();
    if (structure == null) {
      callback.onSuccess(null);
      return;
    }

    ParsedForm parsed = parseStructure(this, structure);
    if (parsed == null || !parsed.hasAnyTarget()) {
      callback.onSuccess(null);
      return;
    }

    AutofillStore store = AutofillStore.getInstance(this);
    AutofillStore.VaultSnapshot snapshot = store.loadVault();
    if (snapshot == null || !snapshot.unlocked) {
      callback.onSuccess(buildLockedResponse(this, parsed));
      return;
    }

    FillResponse unlockedResponse = buildUnlockedResponse(this, parsed, snapshot);
    callback.onSuccess(unlockedResponse);
  }

  @Override
  public void onSaveRequest(SaveRequest request, SaveCallback callback) {
    List<FillContext> contexts = request.getFillContexts();
    if (contexts == null || contexts.isEmpty()) {
      callback.onSuccess();
      return;
    }

    String domain = "";
    String pkg = "";
    String username = "";
    String password = "";

    for (FillContext ctx : contexts) {
      if (ctx == null || ctx.getStructure() == null) {
        continue;
      }
      ParsedForm parsed = parseStructure(this, ctx.getStructure());
      if (parsed == null) {
        continue;
      }
      if (!parsed.webDomain.isEmpty()) {
        domain = parsed.webDomain;
      }
      if (!parsed.packageName.isEmpty()) {
        pkg = parsed.packageName;
      }
      if (!parsed.usernameText.isEmpty()) {
        username = parsed.usernameText;
      }
      if (!parsed.passwordText.isEmpty()) {
        password = parsed.passwordText;
      }
    }

    Bundle clientState = request.getClientState();
    if (clientState != null) {
      if (domain.isEmpty()) {
        domain = AutofillStore.extractHost(clientState.getString("domain", ""));
      }
      if (pkg.isEmpty()) {
        pkg = safeTrim(clientState.getString("packageName", ""));
      }
    }

    if (!isSelfPackage(this, pkg) && !password.isEmpty()) {
      AutofillStore.getInstance(this).addPendingSave(domain, pkg, username, password);
    }
    callback.onSuccess();
  }

  public static FillResponse buildResponseForStructure(
      Context context, AssistStructure structure, AutofillStore store) {
    if (structure == null || store == null) {
      return null;
    }
    ParsedForm parsed = parseStructure(context, structure);
    if (parsed == null || !parsed.hasAnyTarget()) {
      return null;
    }
    AutofillStore.VaultSnapshot snapshot = store.loadVault();
    if (snapshot == null || !snapshot.unlocked) {
      return null;
    }
    return buildUnlockedResponse(context, parsed, snapshot);
  }

  private static FillResponse buildLockedResponse(Context context, ParsedForm parsed) {
    AutofillId[] triggerIds = parsed.targetIds();
    if (triggerIds.length == 0) {
      return null;
    }
    String authToken = AutofillStore.issueAuthToken();
    Intent authIntent = new Intent(context, NonePwdHostActivity.class);
    authIntent.putExtra(NonePwdHostActivity.EXTRA_AUTOFILL_AUTH_TOKEN, authToken);
    int flags =
        PendingIntent.FLAG_CANCEL_CURRENT
            | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
    PendingIntent pendingIntent = PendingIntent.getActivity(context, 1001, authIntent, flags);

    RemoteViews presentation = new RemoteViews(context.getPackageName(), R.layout.autofill_dataset);
    presentation.setTextViewText(R.id.autofill_title, "解锁 NonePwd 自动填充");
    presentation.setTextViewText(R.id.autofill_subtitle, "点击解锁后自动填充账号与验证码");

    return new FillResponse.Builder()
        .setAuthentication(triggerIds, pendingIntent.getIntentSender(), presentation)
        .build();
  }

  private static FillResponse buildUnlockedResponse(
      Context context, ParsedForm parsed, AutofillStore.VaultSnapshot snapshot) {
    FillResponse.Builder responseBuilder = new FillResponse.Builder();
    int addedDatasets = 0;

    boolean otpOnlyScreen =
        parsed.otpId != null && parsed.usernameId == null && parsed.passwordId == null;

    if (parsed.otpId != null && !snapshot.latestOtpCode.isEmpty()) {
      RemoteViews otpView = new RemoteViews(context.getPackageName(), R.layout.autofill_dataset);
      otpView.setTextViewText(R.id.autofill_title, "验证码 " + snapshot.latestOtpCode);
      String sender =
          snapshot.latestOtpSender.isEmpty() ? "收件箱实时验证码" : ("来自 " + snapshot.latestOtpSender);
      otpView.setTextViewText(R.id.autofill_subtitle, sender);

      Dataset.Builder otpDataset = new Dataset.Builder(otpView);
      otpDataset.setValue(parsed.otpId, AutofillValue.forText(snapshot.latestOtpCode));
      responseBuilder.addDataset(otpDataset.build());
      addedDatasets++;
    }

    List<ScoredCredential> ranked = rankCredentials(snapshot.credentials, parsed);
    int limit = ranked.isEmpty() ? 0 : Math.min(ranked.size(), MAX_DATASETS);
    for (int i = 0; i < limit; i++) {
      AutofillStore.Credential cred = ranked.get(i).credential;
      String totpCode = cred.totp.isEmpty() ? null : TotpHelper.generate(cred.totp);
      if (otpOnlyScreen && (totpCode == null || totpCode.isEmpty())) {
        continue;
      }

      boolean fillsUsername = parsed.usernameId != null && !cred.username.isEmpty();
      boolean fillsPassword = parsed.passwordId != null && !cred.password.isEmpty();
      boolean fillsOtp = parsed.otpId != null && totpCode != null && !totpCode.isEmpty();
      if (!fillsUsername && !fillsPassword && !fillsOtp) {
        continue;
      }

      String title = !cred.title.isEmpty() ? cred.title : (!cred.domains.isEmpty() ? cred.domains.get(0) : cred.username);
      if (title.isEmpty()) {
        title = "NonePwd 凭据";
      }

      String subtitle;
      if (fillsOtp) {
        subtitle =
            (!cred.username.isEmpty() ? cred.username + " · " : "") + "含 2FA (" + totpCode + ")";
      } else if (!cred.username.isEmpty()) {
        subtitle =
            !cred.domains.isEmpty()
                ? (cred.username + " · " + cred.domains.get(0))
                : cred.username;
      } else {
        subtitle = !cred.domains.isEmpty() ? cred.domains.get(0) : "已保存密码";
      }

      RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.autofill_dataset);
      row.setTextViewText(R.id.autofill_title, title);
      row.setTextViewText(R.id.autofill_subtitle, subtitle);

      Dataset.Builder dsBuilder = new Dataset.Builder(row);
      if (fillsUsername) {
        dsBuilder.setValue(parsed.usernameId, AutofillValue.forText(cred.username));
      }
      if (fillsPassword) {
        dsBuilder.setValue(parsed.passwordId, AutofillValue.forText(cred.password));
      }
      if (fillsOtp) {
        dsBuilder.setValue(parsed.otpId, AutofillValue.forText(totpCode));
      }
      responseBuilder.addDataset(dsBuilder.build());
      addedDatasets++;
    }

    boolean hasSaveInfo = false;
    if (parsed.usernameId != null && parsed.passwordId != null) {
      SaveInfo.Builder saveBuilder =
          new SaveInfo.Builder(
              SaveInfo.SAVE_DATA_TYPE_USERNAME | SaveInfo.SAVE_DATA_TYPE_PASSWORD,
              new AutofillId[] {parsed.usernameId, parsed.passwordId});
      responseBuilder.setSaveInfo(saveBuilder.build());
      hasSaveInfo = true;
    }

    if (!parsed.webDomain.isEmpty() || !parsed.packageName.isEmpty()) {
      Bundle clientState = new Bundle();
      clientState.putString("domain", parsed.webDomain);
      clientState.putString("packageName", parsed.packageName);
      responseBuilder.setClientState(clientState);
    }

    if (addedDatasets == 0 && !hasSaveInfo) {
      return null;
    }
    return responseBuilder.build();
  }

  private static List<ScoredCredential> rankCredentials(
      List<AutofillStore.Credential> credentials, ParsedForm parsed) {
    if (credentials == null || credentials.isEmpty()) {
      return Collections.emptyList();
    }

    String targetHost = AutofillStore.extractHost(parsed.webDomain);
    String targetRegDomain = registrableDomain(targetHost);
    Set<String> pkgTokens = extractPackageTokens(parsed.packageName);

    List<ScoredCredential> matched = new ArrayList<>();

    for (AutofillStore.Credential cred : credentials) {
      int score = 0;
      for (String credDomain : cred.domains) {
        if (credDomain.isEmpty()) {
          continue;
        }
        if (!targetHost.isEmpty()) {
          if (credDomain.equals(targetHost)) {
            score = Math.max(score, 100);
          } else {
            String credReg = registrableDomain(credDomain);
            if (!targetRegDomain.isEmpty() && credReg.equals(targetRegDomain)) {
              score = Math.max(score, 80);
            }
          }
        }
        if (!pkgTokens.isEmpty()) {
          String brand = brandToken(credDomain);
          if (!brand.isEmpty() && pkgTokens.contains(brand)) {
            score = Math.max(score, 60);
          }
        }
      }

      if (score == 0 && !cred.title.isEmpty()) {
        String lowerTitle = cred.title.toLowerCase(Locale.US);
        if (!pkgTokens.isEmpty()) {
          for (String token : pkgTokens) {
            if (lowerTitle.contains(token)) {
              score = 55;
              break;
            }
          }
        }
        if (score == 0 && !targetHost.isEmpty()) {
          String targetBrand = brandToken(targetHost);
          if (targetBrand.length() >= 3 && lowerTitle.contains(targetBrand)) {
            score = 50;
          }
        }
      }

      if (score > 0) {
        if (parsed.otpId != null && !cred.totp.isEmpty()) {
          score += 15;
        }
        matched.add(new ScoredCredential(cred, score));
      }
    }

    if (matched.isEmpty()) {
      return Collections.emptyList();
    }

    Comparator<ScoredCredential> byScoreDesc =
        (a, b) -> Integer.compare(b.score, a.score);
    Collections.sort(matched, byScoreDesc);
    return matched;
  }

  static ParsedForm parseStructure(Context context, AssistStructure structure) {
    ParsedForm form = new ParsedForm();
    if (structure.getActivityComponent() != null) {
      form.packageName = safeTrim(structure.getActivityComponent().getPackageName());
    }
    if (isSelfPackage(context, form.packageName)) {
      return null;
    }

    boolean allowWebDomain = TRUSTED_BROWSER_PACKAGES.contains(form.packageName);
    int windows = structure.getWindowNodeCount();
    for (int i = 0; i < windows; i++) {
      AssistStructure.WindowNode window = structure.getWindowNodeAt(i);
      if (window != null && window.getRootViewNode() != null) {
        traverseNode(context, window.getRootViewNode(), form, allowWebDomain);
      }
    }

    if (form.usernameId == null && form.passwordId != null && form.fallbackTextId != null) {
      form.usernameId = form.fallbackTextId;
    }
    if (isSelfPackage(context, form.packageName)) {
      return null;
    }
    return form;
  }

  private static void traverseNode(
      Context context,
      AssistStructure.ViewNode node,
      ParsedForm form,
      boolean allowWebDomain) {
    if (node == null) {
      return;
    }

    String idPackage = safeTrim(node.getIdPackage());
    if (isSelfPackage(context, idPackage)) {
      form.packageName = idPackage;
      return;
    }

    if (allowWebDomain) {
      String nodeWebDomain = AutofillStore.extractHost(node.getWebDomain());
      if (!nodeWebDomain.isEmpty()) {
        if (form.webDomain.isEmpty()) {
          form.webDomain = nodeWebDomain;
        } else if (!nodeWebDomain.equals(form.webDomain)) {
          // Do not allow cross-origin subframes/iframes to overwrite root domain or receive root credentials
          return;
        }
      }
    }

    AutofillId autofillId = node.getAutofillId();
    if (autofillId != null
        && node.getAutofillType() != View.AUTOFILL_TYPE_NONE
        && node.getVisibility() == View.VISIBLE
        && node.isEnabled()) {
      classifyNode(node, autofillId, form);
    }

    int count = node.getChildCount();
    for (int i = 0; i < count; i++) {
      traverseNode(context, node.getChildAt(i), form, allowWebDomain);
    }
  }

  private static void classifyNode(
      AssistStructure.ViewNode node, AutofillId autofillId, ParsedForm form) {
    StringBuilder signals = new StringBuilder();
    appendLower(signals, node.getHint());
    appendLower(signals, node.getIdEntry());
    if (node.getContentDescription() != null) {
      appendLower(signals, node.getContentDescription().toString());
    }

    String htmlType = "";
    String htmlAutocomplete = "";
    ViewStructure.HtmlInfo htmlInfo = node.getHtmlInfo();
    boolean isHtmlInput = false;
    if (htmlInfo != null) {
      String tag = safeTrim(htmlInfo.getTag()).toLowerCase(Locale.US);
      isHtmlInput = "input".equals(tag) || "textarea".equals(tag);
      List<Pair<String, String>> attrs = htmlInfo.getAttributes();
      if (attrs != null) {
        for (Pair<String, String> pair : attrs) {
          if (pair == null || pair.first == null || pair.second == null) {
            continue;
          }
          String attrName = pair.first.toLowerCase(Locale.US);
          String attrVal = pair.second.toLowerCase(Locale.US);
          if ("type".equals(attrName)) {
            htmlType = attrVal;
          } else if ("autocomplete".equals(attrName)) {
            htmlAutocomplete = attrVal;
          }
          if ("name".equals(attrName)
              || "id".equals(attrName)
              || "placeholder".equals(attrName)
              || "aria-label".equals(attrName)
              || "autocomplete".equals(attrName)
              || "role".equals(attrName)) {
            appendLower(signals, attrVal);
          }
        }
      }
    }

    String[] hints = node.getAutofillHints();
    boolean hintOtp = false;
    boolean hintPassword = false;
    boolean hintUsername = false;
    if (hints != null) {
      for (String h : hints) {
        if (h == null) {
          continue;
        }
        String hl = h.toLowerCase(Locale.US);
        appendLower(signals, hl);
        if (hl.contains("otp") || hl.contains("one-time-code") || hl.contains("2fa") || hl.contains("totp")) {
          hintOtp = true;
        } else if (View.AUTOFILL_HINT_PASSWORD.equalsIgnoreCase(h)
            || hl.contains("password")) {
          hintPassword = true;
        } else if (View.AUTOFILL_HINT_USERNAME.equalsIgnoreCase(h)
            || View.AUTOFILL_HINT_EMAIL_ADDRESS.equalsIgnoreCase(h)
            || hl.contains("username")
            || hl.contains("email")) {
          hintUsername = true;
        }
      }
    }

    if ("search".equals(htmlType) || "hidden".equals(htmlType) || "submit".equals(htmlType) || "button".equals(htmlType)) {
      return;
    }
    String sig = signals.toString();
    if (isSearchSignal(sig)) {
      return;
    }

    int inputType = node.getInputType();
    int klass = inputType & InputType.TYPE_MASK_CLASS;
    int variation = inputType & InputType.TYPE_MASK_VARIATION;

    boolean isPasswordType =
        (klass == InputType.TYPE_CLASS_TEXT
                && (variation == InputType.TYPE_TEXT_VARIATION_PASSWORD
                    || variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD
                    || variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD))
            || (klass == InputType.TYPE_CLASS_NUMBER
                && variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD)
            || "password".equals(htmlType);

    boolean isEmailType =
        (klass == InputType.TYPE_CLASS_TEXT
                && (variation == InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
                    || variation == InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS))
            || "email".equals(htmlType);

    boolean isOtpSignal =
        hintOtp
            || htmlAutocomplete.contains("one-time-code")
            || containsAny(
                sig,
                "one-time-code",
                "one time code",
                "2fa",
                "totp",
                "otp",
                "verification code",
                "verification_code",
                "auth_code",
                "authcode",
                "security code",
                "验证码",
                "动态码",
                "校验码");

    boolean isPasswordSignal =
        hintPassword
            || isPasswordType
            || htmlAutocomplete.contains("password")
            || (!isOtpSignal
                && containsAny(sig, "password", "passwd", "passcode", "密码"));

    boolean isUsernameSignal =
        hintUsername
            || isEmailType
            || htmlAutocomplete.contains("username")
            || htmlAutocomplete.contains("email")
            || (!isPasswordSignal
                && !isOtpSignal
                && containsAny(
                    sig,
                    "username",
                    "user_name",
                    "user-name",
                    "userid",
                    "user_id",
                    "email",
                    "e-mail",
                    "account",
                    "login",
                    "账号",
                    "用户名",
                    "邮箱",
                    "手机号"));

    String currentText = extractNodeText(node);

    if (isOtpSignal) {
      if (form.otpId == null || node.isFocused()) {
        form.otpId = autofillId;
      }
      return;
    }

    if (isPasswordSignal) {
      if (form.passwordId == null || node.isFocused()) {
        form.passwordId = autofillId;
        if (!currentText.isEmpty()) {
          form.passwordText = currentText;
        }
      }
      return;
    }

    if (isUsernameSignal) {
      if (form.usernameId == null || node.isFocused()) {
        form.usernameId = autofillId;
        if (!currentText.isEmpty()) {
          form.usernameText = currentText;
        }
      }
      return;
    }

    // Track preceding editable text input as fallback username before a password field
    String className = safeTrim(node.getClassName()).toLowerCase(Locale.US);
    boolean isEditableText =
        isHtmlInput || className.contains("edittext") || node.isFocusable();
    if (isEditableText && form.passwordId == null) {
      form.fallbackTextId = autofillId;
      if (form.usernameText.isEmpty() && !currentText.isEmpty()) {
        form.usernameText = currentText;
      }
    }
  }

  private static String extractNodeText(AssistStructure.ViewNode node) {
    AutofillValue value = node.getAutofillValue();
    if (value != null && value.isText() && value.getTextValue() != null) {
      return value.getTextValue().toString();
    }
    if (node.getText() != null) {
      return node.getText().toString();
    }
    return "";
  }

  private static boolean isSearchSignal(String sig) {
    if (sig.contains("searchbox") || sig.contains("搜索") || sig.contains("查找")) {
      return true;
    }
    if (sig.contains("search") && !sig.contains("user") && !sig.contains("login")) {
      return true;
    }
    return false;
  }

  private static boolean containsAny(String haystack, String... needles) {
    for (String needle : needles) {
      if (haystack.contains(needle)) {
        return true;
      }
    }
    return false;
  }

  private static void appendLower(StringBuilder sb, String s) {
    if (s != null && !s.isEmpty()) {
      sb.append(' ').append(s.toLowerCase(Locale.US));
    }
  }

  private static String registrableDomain(String host) {
    if (host == null || host.isEmpty()) {
      return "";
    }
    if ("localhost".equals(host)) {
      return host;
    }
    String[] parts = host.split("\\.");
    boolean allNumeric = true;
    for (String p : parts) {
      if (p.isEmpty() || !p.matches("\\d+")) {
        allNumeric = false;
        break;
      }
    }
    if (allNumeric || parts.length <= 2) {
      return host;
    }
    String lastTwo = parts[parts.length - 2] + "." + parts[parts.length - 1];
    if (MULTI_PART_SUFFIXES.contains(lastTwo) && parts.length >= 3) {
      return parts[parts.length - 3] + "." + lastTwo;
    }
    return lastTwo;
  }

  private static String brandToken(String host) {
    String reg = registrableDomain(host);
    if (reg.isEmpty()) {
      return "";
    }
    int dot = reg.indexOf('.');
    return dot > 0 ? reg.substring(0, dot) : reg;
  }

  private static Set<String> extractPackageTokens(String packageName) {
    if (packageName == null || packageName.isEmpty()) {
      return Collections.emptySet();
    }
    String[] parts = packageName.toLowerCase(Locale.US).split("[._-]");
    Set<String> tokens = new HashSet<>();
    for (String part : parts) {
      if (part.length() >= 3 && !IGNORED_PKG_TOKENS.contains(part)) {
        tokens.add(part);
      }
    }
    return tokens;
  }

  private static boolean isSelfPackage(Context context, String packageName) {
    if (packageName == null || packageName.isEmpty()) {
      return false;
    }
    return "dev.nonepwd.app".equals(packageName)
        || packageName.equals(context.getPackageName());
  }

  private static String safeTrim(String s) {
    return s == null ? "" : s.trim();
  }
}

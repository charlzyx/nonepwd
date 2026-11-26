package dev.nonepwd.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * AndroidKeyStore AES-256-GCM backed storage for unlocked autofill credentials and captured saves.
 */
public final class AutofillStore {
  private static final String PREFS_NAME = "nonepwd_autofill_v1";
  private static final String KEY_VAULT_ENC = "vault_enc_v1";
  private static final String KEY_PENDING_SAVES_ENC = "pending_saves_enc_v1";
  private static final String CIPHER_TRANSFORMATION = "AES/GCM/NoPadding";
  private static final int GCM_IV_BYTES = 12;
  private static final int GCM_TAG_BITS = 128;
  private static final int MAX_PENDING_SAVES = 20;
  private static final long AUTH_TOKEN_TTL_MS = 2L * 60L * 1000L;
  private static final long SESSION_MAX_TTL_MS = 4L * 60L * 60L * 1000L;

  private static final SecureRandom SECURE_RANDOM = new SecureRandom();
  private static String activeAuthToken;
  private static long activeAuthTokenExpiresAtMs;

  private static AutofillStore instance;

  private final SharedPreferences prefs;
  private VaultSnapshot volatileSessionVault;

  public static final class Credential {
    public final String id;
    public final String title;
    public final String username;
    public final String password;
    public final String totp;
    public final String emailAlias;
    public final List<String> domains;

    public Credential(
        String id,
        String title,
        String username,
        String password,
        String totp,
        String emailAlias,
        List<String> domains) {
      this.id = id;
      this.title = title;
      this.username = username;
      this.password = password;
      this.totp = totp;
      this.emailAlias = emailAlias;
      this.domains = domains;
    }
  }

  public static final class VaultSnapshot {
    public final boolean unlocked;
    public final long expiresAtMs;
    public final String latestOtpCode;
    public final String latestOtpSender;
    public final List<Credential> credentials;

    public VaultSnapshot(
        boolean unlocked,
        long expiresAtMs,
        String latestOtpCode,
        String latestOtpSender,
        List<Credential> credentials) {
      this.unlocked = unlocked;
      this.expiresAtMs = expiresAtMs;
      this.latestOtpCode = latestOtpCode;
      this.latestOtpSender = latestOtpSender;
      this.credentials = credentials;
    }
  }

  private AutofillStore(Context context) {
    Context appCtx = context.getApplicationContext();
    Context target = appCtx != null ? appCtx : context;
    this.prefs = target.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
  }

  public static synchronized AutofillStore getInstance(Context context) {
    if (instance == null) {
      instance = new AutofillStore(context);
    }
    return instance;
  }

  public static String issueAuthToken() {
    byte[] bytes = new byte[16];
    SECURE_RANDOM.nextBytes(bytes);
    StringBuilder hex = new StringBuilder(bytes.length * 2);
    for (byte b : bytes) {
      hex.append(Character.forDigit((b >>> 4) & 0x0f, 16));
      hex.append(Character.forDigit(b & 0x0f, 16));
    }
    String token = hex.toString();
    synchronized (AutofillStore.class) {
      activeAuthToken = token;
      activeAuthTokenExpiresAtMs = System.currentTimeMillis() + AUTH_TOKEN_TTL_MS;
    }
    return token;
  }

  public static boolean consumeAuthToken(String candidate) {
    synchronized (AutofillStore.class) {
      if (candidate == null || candidate.isEmpty() || activeAuthToken == null) {
        return false;
      }
      if (System.currentTimeMillis() > activeAuthTokenExpiresAtMs) {
        activeAuthToken = null;
        activeAuthTokenExpiresAtMs = 0L;
        return false;
      }
      boolean matched =
          MessageDigest.isEqual(
              activeAuthToken.getBytes(StandardCharsets.UTF_8),
              candidate.getBytes(StandardCharsets.UTF_8));
      if (matched) {
        activeAuthToken = null;
        activeAuthTokenExpiresAtMs = 0L;
        return true;
      }
      return false;
    }
  }

  public void sync(
      boolean unlocked,
      long expiresAtMs,
      JSONArray credentialsJson,
      String latestOtpCode,
      String latestOtpSender) {
    synchronized (AutofillStore.class) {
      if (!unlocked || (expiresAtMs > 0L && isExpired(expiresAtMs))) {
        clearVaultLocked();
        return;
      }

      boolean sessionOnly = expiresAtMs <= 0L;
      String cleanOtpCode = safeTrim(latestOtpCode);
      String cleanOtpSender = safeTrim(latestOtpSender);

      try {
        JSONArray normalizedList = new JSONArray();
        List<Credential> memoryCredentials = new ArrayList<>();
        if (credentialsJson != null) {
          for (int i = 0; i < credentialsJson.length(); i++) {
            JSONObject item = credentialsJson.optJSONObject(i);
            if (item == null) {
              continue;
            }
            String username = safeTrim(item.optString("username", ""));
            String password = item.optString("password", "");
            if (password == null) {
              password = "";
            }
            String totp = safeTrim(item.optString("totp", ""));
            String emailAlias = safeTrim(item.optString("emailAlias", ""));
            if (username.isEmpty() && password.isEmpty() && totp.isEmpty()) {
              continue;
            }

            Set<String> hostSet = new LinkedHashSet<>();
            collectHosts(item.optJSONArray("domains"), hostSet);
            collectHosts(item.optJSONArray("urls"), hostSet);
            String singleDomain = extractHost(item.optString("domain", ""));
            if (!singleDomain.isEmpty()) {
              hostSet.add(singleDomain);
            }

            String id = safeTrim(item.optString("id", ""));
            String title = safeTrim(item.optString("title", ""));
            List<String> hostList = Collections.unmodifiableList(new ArrayList<>(hostSet));

            if (sessionOnly) {
              memoryCredentials.add(
                  new Credential(id, title, username, password, totp, emailAlias, hostList));
            } else {
              JSONObject entry = new JSONObject();
              entry.put("id", id);
              entry.put("title", title);
              entry.put("username", username);
              entry.put("password", password);
              entry.put("totp", totp);
              entry.put("emailAlias", emailAlias);
              JSONArray domainsArr = new JSONArray();
              for (String host : hostList) {
                domainsArr.put(host);
              }
              entry.put("domains", domainsArr);
              normalizedList.put(entry);
            }
          }
        }

        if (sessionOnly) {
          prefs.edit().remove(KEY_VAULT_ENC).commit();
          volatileSessionVault =
              new VaultSnapshot(
                  true,
                  System.currentTimeMillis() + SESSION_MAX_TTL_MS,
                  cleanOtpCode,
                  cleanOtpSender,
                  Collections.unmodifiableList(memoryCredentials));
          return;
        }

        volatileSessionVault = null;
        JSONObject root = new JSONObject();
        root.put("unlocked", true);
        root.put("expiresAtMs", expiresAtMs);
        root.put("latestOtpCode", cleanOtpCode);
        root.put("latestOtpSender", cleanOtpSender);
        root.put("credentials", normalizedList);

        String encrypted = encryptString(root.toString());
        if (encrypted != null) {
          prefs.edit().putString(KEY_VAULT_ENC, encrypted).commit();
        } else {
          clearVaultLocked();
        }
      } catch (JSONException ignored) {
        clearVaultLocked();
      }
    }
  }

  public void clearVault() {
    synchronized (AutofillStore.class) {
      clearVaultLocked();
    }
  }

  public boolean isUnlocked() {
    synchronized (AutofillStore.class) {
      return loadVaultLocked() != null;
    }
  }

  public VaultSnapshot loadVault() {
    synchronized (AutofillStore.class) {
      return loadVaultLocked();
    }
  }

  public void addPendingSave(String domain, String packageName, String username, String password) {
    if (password == null || password.isEmpty()) {
      return;
    }
    synchronized (AutofillStore.class) {
      String normDomain = extractHost(domain);
      String normPkg = safeTrim(packageName);
      String normUser = safeTrim(username);
      if (normDomain.isEmpty() && !normPkg.isEmpty()) {
        normDomain = normPkg;
      }

      JSONArray existing = readPendingSavesLocked();
      JSONArray updated = new JSONArray();
      long now = System.currentTimeMillis();

      try {
        JSONObject newItem = new JSONObject();
        newItem.put("id", UUID.randomUUID().toString());
        newItem.put("domain", normDomain);
        if (!normPkg.isEmpty()) {
          newItem.put("packageName", normPkg);
        }
        newItem.put("username", normUser);
        newItem.put("password", password);
        newItem.put("capturedAtMs", now);
        updated.put(newItem);

        for (int i = 0; i < existing.length() && updated.length() < MAX_PENDING_SAVES; i++) {
          JSONObject prev = existing.optJSONObject(i);
          if (prev == null) {
            continue;
          }
          String prevDomain = extractHost(prev.optString("domain", ""));
          String prevPkg = safeTrim(prev.optString("packageName", ""));
          String prevUser = safeTrim(prev.optString("username", ""));
          boolean sameTarget =
              normUser.equals(prevUser)
                  && ((!normDomain.isEmpty() && normDomain.equals(prevDomain))
                      || (!normPkg.isEmpty() && normPkg.equals(prevPkg)));
          if (!sameTarget) {
            updated.put(prev);
          }
        }

        String encrypted = encryptString(updated.toString());
        if (encrypted != null) {
          prefs.edit().putString(KEY_PENDING_SAVES_ENC, encrypted).commit();
        }
      } catch (JSONException ignored) {
        // Ignore malformed item
      }
    }
  }

  public JSONArray takePendingSavesJson() {
    synchronized (AutofillStore.class) {
      JSONArray items = readPendingSavesLocked();
      prefs.edit().remove(KEY_PENDING_SAVES_ENC).commit();
      return items;
    }
  }

  public static String extractHost(String raw) {
    if (raw == null) {
      return "";
    }
    String trimmed = raw.trim().toLowerCase(Locale.US);
    if (trimmed.isEmpty()) {
      return "";
    }
    String host = "";
    try {
      String withScheme =
          (trimmed.startsWith("http://") || trimmed.startsWith("https://"))
              ? trimmed
              : ("https://" + trimmed);
      Uri uri = Uri.parse(withScheme);
      if (uri != null && uri.getHost() != null) {
        host = uri.getHost().trim().toLowerCase(Locale.US);
      }
    } catch (Throwable ignored) {
      host = "";
    }
    if (host.isEmpty()) {
      String stripped = trimmed.replaceFirst("^[a-z0-9+.-]+://", "");
      int slash = stripped.indexOf('/');
      if (slash >= 0) {
        stripped = stripped.substring(0, slash);
      }
      int query = stripped.indexOf('?');
      if (query >= 0) {
        stripped = stripped.substring(0, query);
      }
      int colon = stripped.indexOf(':');
      if (colon >= 0) {
        stripped = stripped.substring(0, colon);
      }
      host = stripped.trim().toLowerCase(Locale.US);
    }
    while (host.startsWith(".")) {
      host = host.substring(1);
    }
    while (host.endsWith(".")) {
      host = host.substring(0, host.length() - 1);
    }
    if (host.startsWith("www.") && host.length() > 4) {
      host = host.substring(4);
    }
    return host;
  }

  private void clearVaultLocked() {
    volatileSessionVault = null;
    prefs.edit().remove(KEY_VAULT_ENC).commit();
  }

  private VaultSnapshot loadVaultLocked() {
    if (volatileSessionVault != null) {
      if (isExpired(volatileSessionVault.expiresAtMs)) {
        volatileSessionVault = null;
      } else {
        return volatileSessionVault;
      }
    }
    String enc = prefs.getString(KEY_VAULT_ENC, null);
    if (enc == null || enc.isEmpty()) {
      return null;
    }
    String plain = decryptString(enc);
    if (plain == null || plain.isEmpty()) {
      clearVaultLocked();
      return null;
    }
    try {
      JSONObject root = new JSONObject(plain);
      boolean unlocked = root.optBoolean("unlocked", false);
      long expiresAtMs = root.optLong("expiresAtMs", 0L);
      if (!unlocked || expiresAtMs <= 0L || isExpired(expiresAtMs)) {
        clearVaultLocked();
        return null;
      }
      String latestOtpCode = safeTrim(root.optString("latestOtpCode", ""));
      String latestOtpSender = safeTrim(root.optString("latestOtpSender", ""));
      JSONArray credArray = root.optJSONArray("credentials");
      List<Credential> credentials = new ArrayList<>();
      if (credArray != null) {
        for (int i = 0; i < credArray.length(); i++) {
          JSONObject item = credArray.optJSONObject(i);
          if (item == null) {
            continue;
          }
          List<String> domains = new ArrayList<>();
          JSONArray domArr = item.optJSONArray("domains");
          if (domArr != null) {
            for (int j = 0; j < domArr.length(); j++) {
              String d = extractHost(domArr.optString(j, ""));
              if (!d.isEmpty()) {
                domains.add(d);
              }
            }
          }
          credentials.add(
              new Credential(
                  safeTrim(item.optString("id", "")),
                  safeTrim(item.optString("title", "")),
                  safeTrim(item.optString("username", "")),
                  item.optString("password", ""),
                  safeTrim(item.optString("totp", "")),
                  safeTrim(item.optString("emailAlias", "")),
                  Collections.unmodifiableList(domains)));
        }
      }
      return new VaultSnapshot(
          true,
          expiresAtMs,
          latestOtpCode,
          latestOtpSender,
          Collections.unmodifiableList(credentials));
    } catch (JSONException ignored) {
      clearVaultLocked();
      return null;
    }
  }

  private JSONArray readPendingSavesLocked() {
    String enc = prefs.getString(KEY_PENDING_SAVES_ENC, null);
    if (enc == null || enc.isEmpty()) {
      return new JSONArray();
    }
    String plain = decryptString(enc);
    if (plain == null || plain.isEmpty()) {
      prefs.edit().remove(KEY_PENDING_SAVES_ENC).commit();
      return new JSONArray();
    }
    try {
      return new JSONArray(plain);
    } catch (JSONException ignored) {
      prefs.edit().remove(KEY_PENDING_SAVES_ENC).commit();
      return new JSONArray();
    }
  }

  private static boolean isExpired(long expiresAtMs) {
    return expiresAtMs > 0L && System.currentTimeMillis() > expiresAtMs;
  }

  private static void collectHosts(JSONArray arr, Set<String> out) {
    if (arr == null) {
      return;
    }
    for (int i = 0; i < arr.length(); i++) {
      String host = extractHost(arr.optString(i, ""));
      if (!host.isEmpty()) {
        out.add(host);
      }
    }
  }

  private static String safeTrim(String value) {
    return value == null ? "" : value.trim();
  }

  private static boolean isKeyStoreAvailable() {
    if (Build.VERSION.SDK_INT < 23) {
      return false;
    }
    try {
      Class.forName("android.security.keystore.KeyGenParameterSpec");
      Class.forName("android.security.keystore.KeyProperties");
      return true;
    } catch (Throwable ignored) {
      return false;
    }
  }

  private static SecretKey invokeKeyStoreHelper(String methodName, Boolean forceRecreate) {
    if (!isKeyStoreAvailable()) {
      return null;
    }
    try {
      Class<?> helper = Class.forName("dev.nonepwd.app.AutofillKeyStoreHelper");
      Object res =
          forceRecreate != null
              ? helper.getMethod(methodName, boolean.class).invoke(null, forceRecreate)
              : helper.getMethod(methodName).invoke(null);
      return res instanceof SecretKey ? (SecretKey) res : null;
    } catch (Throwable ignored) {
      return null;
    }
  }

  private String encryptString(String plaintext) {
    if (plaintext == null || !isKeyStoreAvailable()) {
      return null;
    }
    for (int attempt = 0; attempt < 2; attempt++) {
      try {
        SecretKey key = invokeKeyStoreHelper("getOrCreateSecretKey", attempt > 0);
        if (key == null) {
          return null;
        }
        Cipher cipher = Cipher.getInstance(CIPHER_TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] iv = cipher.getIV();
        if (iv == null || iv.length != GCM_IV_BYTES) {
          throw new GeneralSecurityException("Unexpected GCM IV length");
        }
        byte[] ct = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
        byte[] combined = new byte[GCM_IV_BYTES + ct.length];
        System.arraycopy(iv, 0, combined, 0, GCM_IV_BYTES);
        System.arraycopy(ct, 0, combined, GCM_IV_BYTES, ct.length);
        return Base64.encodeToString(combined, Base64.NO_WRAP);
      } catch (Throwable ignored) {
        // Retry once with regenerated keystore key on key invalidation, or degrade gracefully
      }
    }
    return null;
  }

  private String decryptString(String encoded) {
    if (encoded == null || encoded.isEmpty() || !isKeyStoreAvailable()) {
      return null;
    }
    try {
      byte[] combined = Base64.decode(encoded, Base64.NO_WRAP);
      if (combined.length < GCM_IV_BYTES + 16) {
        return null;
      }
      SecretKey key = invokeKeyStoreHelper("loadExistingSecretKey", null);
      if (key == null) {
        return null;
      }
      Cipher cipher = Cipher.getInstance(CIPHER_TRANSFORMATION);
      GCMParameterSpec spec = new GCMParameterSpec(GCM_TAG_BITS, combined, 0, GCM_IV_BYTES);
      cipher.init(Cipher.DECRYPT_MODE, key, spec);
      byte[] plain = cipher.doFinal(combined, GCM_IV_BYTES, combined.length - GCM_IV_BYTES);
      return new String(plain, StandardCharsets.UTF_8);
    } catch (Throwable ignored) {
      return null;
    }
  }
}

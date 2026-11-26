package com.longbridge.nsh;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import dev.nonepwd.app.AutofillStore;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

/**
 * Custom NSH host Activity registering native Android Autofill host handlers alongside NshView.
 */
public final class NonePwdHostActivity extends Activity {
  public static final String EXTRA_AUTOFILL_AUTH_TOKEN = "dev.nonepwd.app.AUTOFILL_AUTH_TOKEN";

  private NshView view;
  private boolean pendingAutofillAuth;
  private Object pendingAssistStructure;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    DevActivity.edgeToEdge(this);

    if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
      DevActivity.applyEnv(getIntent().getExtras());
    }

    captureAutofillAuthIntent(getIntent());

    view = new NshView(this);
    view.useStandaloneLimits();
    registerAutofillHandlers();
    setContentView(view);

    view.handleNotificationIntent(getIntent());
    if (savedInstanceState == null) {
      view.handleUrlSchemeIntent(getIntent());
    }

    view.loadAssetBundle("nsh", true);
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    captureAutofillAuthIntent(intent);
    if (view != null && intent != null) {
      view.handleNotificationIntent(intent);
      view.handleUrlSchemeIntent(intent);
    }
  }

  @Override
  public void onConfigurationChanged(Configuration newConfig) {
    super.onConfigurationChanged(newConfig);
    DevActivity.systemBars(this);
  }

  @Override
  public void onBackPressed() {
    if (view == null || !view.handleBack()) {
      super.onBackPressed();
    }
  }

  @Override
  protected void onDestroy() {
    if (view != null) {
      view.destroy();
    }
    super.onDestroy();
  }

  private void registerAutofillHandlers() {
    view.handle(
        "autofill.status",
        (args, reply) -> {
          JSONObject result = null;
          Class<?> bridge = loadAutofillBridge();
          if (bridge != null) {
            try {
              Object out = bridge.getMethod("getStatus", Context.class).invoke(null, this);
              if (out instanceof JSONObject) {
                result = (JSONObject) out;
              }
            } catch (Throwable ignored) {
              result = null;
            }
          }
          if (result == null) {
            result = new JSONObject();
            try {
              result.put("available", true);
              result.put("supported", false);
              result.put("enabled", false);
            } catch (JSONException ignored) {
              // Unreachable for boolean keys
            }
          }
          reply.resolve(result);
        });

    view.handle(
        "autofill.enable",
        (args, reply) -> {
          boolean launched = false;
          Class<?> bridge = loadAutofillBridge();
          if (bridge != null) {
            try {
              Object out =
                  bridge.getMethod("launchEnableSettings", Activity.class).invoke(null, this);
              if (out instanceof Boolean) {
                launched = ((Boolean) out).booleanValue();
              }
            } catch (Throwable ignored) {
              launched = false;
            }
          }
          try {
            JSONObject result = new JSONObject();
            result.put("launched", launched);
            reply.resolve(result);
          } catch (JSONException err) {
            reply.reject(err.getMessage() != null ? err.getMessage() : "autofill.enable failed");
          }
        });

    view.handle(
        "autofill.sync",
        (args, reply) -> {
          try {
            JSONObject payload = toJsonObject(args);
            boolean unlocked = payload.optBoolean("unlocked", false);
            long expiresAtMs = payload.optLong("expiresAtMs", 0L);
            JSONArray credentials = payload.optJSONArray("credentials");
            String latestOtpCode = payload.optString("latestOtpCode", "");
            String latestOtpSender = payload.optString("latestOtpSender", "");

            AutofillStore store = null;
            try {
              store = AutofillStore.getInstance(this);
              store.sync(unlocked, expiresAtMs, credentials, latestOtpCode, latestOtpSender);
            } catch (Throwable ignored) {
              // Gracefully ignore if AndroidKeyStore / SharedPreferences unavailable (e.g. macapk)
            }

            JSONObject result = new JSONObject();
            result.put("ok", true);
            reply.resolve(result);

            if (unlocked && pendingAutofillAuth) {
              final AutofillStore finalStore = store;
              runOnUiThread(() -> completeAutofillAuthentication(finalStore));
            }
          } catch (Throwable err) {
            try {
              JSONObject fallback = new JSONObject();
              fallback.put("ok", false);
              reply.resolve(fallback);
            } catch (JSONException ignored) {
              reply.reject(err.getMessage() != null ? err.getMessage() : "autofill.sync failed");
            }
          }
        });

    view.handle(
        "autofill.takePendingSaves",
        (args, reply) -> {
          JSONArray pending = new JSONArray();
          try {
            pending = AutofillStore.getInstance(this).takePendingSavesJson();
          } catch (Throwable ignored) {
            pending = new JSONArray();
          }
          reply.resolve(pending);
        });
  }

  private static boolean isAutofillFrameworkAvailable() {
    if (Build.VERSION.SDK_INT < 26) {
      return false;
    }
    try {
      Class.forName("android.app.assist.AssistStructure");
      Class.forName("android.view.autofill.AutofillManager");
      Class.forName("android.service.autofill.FillResponse");
      Class.forName("android.service.autofill.AutofillService");
      return true;
    } catch (Throwable ignored) {
      return false;
    }
  }

  private static Class<?> loadAutofillBridge() {
    if (!isAutofillFrameworkAvailable()) {
      return null;
    }
    try {
      return Class.forName("dev.nonepwd.app.AutofillHostBridge");
    } catch (Throwable ignored) {
      return null;
    }
  }

  private void captureAutofillAuthIntent(Intent intent) {
    pendingAutofillAuth = false;
    pendingAssistStructure = null;
    if (intent == null) {
      return;
    }
    String authToken = intent.getStringExtra(EXTRA_AUTOFILL_AUTH_TOKEN);
    if (!AutofillStore.consumeAuthToken(authToken)) {
      return;
    }
    Object structure = null;
    Class<?> bridge = loadAutofillBridge();
    if (bridge != null) {
      try {
        structure = bridge.getMethod("extractAssistStructure", Intent.class).invoke(null, intent);
      } catch (Throwable ignored) {
        structure = null;
      }
    }
    if (structure != null) {
      pendingAutofillAuth = true;
      pendingAssistStructure = structure;
    }
  }

  private void completeAutofillAuthentication(AutofillStore store) {
    pendingAutofillAuth = false;
    Object structure = pendingAssistStructure;
    pendingAssistStructure = null;

    Class<?> bridge = loadAutofillBridge();
    if (bridge != null) {
      try {
        bridge
            .getMethod("completeAuthentication", Activity.class, Object.class, AutofillStore.class)
            .invoke(null, this, structure, store);
        return;
      } catch (Throwable ignored) {
        // Fall back to empty OK result
      }
    }
    setResult(Activity.RESULT_OK, new Intent());
    finish();
  }

  private static JSONObject toJsonObject(Object args) throws JSONException {
    if (args == null) {
      return new JSONObject();
    }
    if (args instanceof JSONObject) {
      return (JSONObject) args;
    }
    if (args instanceof Map<?, ?>) {
      return new JSONObject((Map<?, ?>) args);
    }
    if (args instanceof String) {
      String trimmed = ((String) args).trim();
      if (trimmed.isEmpty()) {
        return new JSONObject();
      }
      Object parsed = new JSONTokener(trimmed).nextValue();
      if (parsed instanceof JSONObject) {
        return (JSONObject) parsed;
      }
      if (parsed instanceof String) {
        String inner = ((String) parsed).trim();
        if (!inner.isEmpty()) {
          Object innerParsed = new JSONTokener(inner).nextValue();
          if (innerParsed instanceof JSONObject) {
            return (JSONObject) innerParsed;
          }
        }
      }
    }
    return new JSONObject();
  }
}

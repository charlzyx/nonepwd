package com.longbridge.nsh;

import android.app.Activity;
import android.app.assist.AssistStructure;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.service.autofill.FillResponse;
import android.view.autofill.AutofillManager;
import dev.nonepwd.app.AutofillStore;
import dev.nonepwd.app.NonePwdAutofillService;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

/**
 * Custom NSH host Activity registering native Android Autofill host handlers alongside NshView.
 */
public final class NonePwdHostActivity extends Activity {
  public static final String EXTRA_AUTOFILL_AUTH = "dev.nonepwd.app.AUTOFILL_AUTH";

  private NshView view;
  private boolean pendingAutofillAuth;
  private AssistStructure pendingAssistStructure;

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
          try {
            AutofillManager afm = getSystemService(AutofillManager.class);
            boolean supported = afm != null && afm.isAutofillSupported();
            boolean enabled = afm != null && afm.hasEnabledAutofillServices();
            JSONObject result = new JSONObject();
            result.put("available", true);
            result.put("supported", supported);
            result.put("enabled", enabled);
            reply.resolve(result);
          } catch (Throwable err) {
            reply.reject(err.getMessage() != null ? err.getMessage() : "autofill.status failed");
          }
        });

    view.handle(
        "autofill.enable",
        (args, reply) -> {
          boolean launched = false;
          try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE);
            intent.setData(Uri.parse("package:" + getPackageName()));
            startActivity(intent);
            launched = true;
          } catch (Throwable ignored) {
            try {
              Intent fallback = new Intent(Settings.ACTION_SETTINGS);
              startActivity(fallback);
              launched = true;
            } catch (Throwable ignored2) {
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

            AutofillStore store = AutofillStore.getInstance(this);
            store.sync(unlocked, expiresAtMs, credentials, latestOtpCode, latestOtpSender);

            JSONObject result = new JSONObject();
            result.put("ok", true);
            reply.resolve(result);

            if (unlocked && pendingAutofillAuth) {
              runOnUiThread(() -> completeAutofillAuthentication(store));
            }
          } catch (Throwable err) {
            reply.reject(err.getMessage() != null ? err.getMessage() : "autofill.sync failed");
          }
        });

    view.handle(
        "autofill.takePendingSaves",
        (args, reply) -> {
          try {
            JSONArray pending = AutofillStore.getInstance(this).takePendingSavesJson();
            reply.resolve(pending);
          } catch (Throwable err) {
            reply.reject(
                err.getMessage() != null ? err.getMessage() : "autofill.takePendingSaves failed");
          }
        });
  }

  private void captureAutofillAuthIntent(Intent intent) {
    pendingAutofillAuth = false;
    pendingAssistStructure = null;
    if (intent == null) {
      return;
    }
    AssistStructure structure = extractAssistStructure(intent);
    if (intent.getBooleanExtra(EXTRA_AUTOFILL_AUTH, false) || structure != null) {
      pendingAutofillAuth = true;
      pendingAssistStructure = structure;
    }
  }

  @SuppressWarnings("deprecation")
  private static AssistStructure extractAssistStructure(Intent intent) {
    if (intent == null) {
      return null;
    }
    if (Build.VERSION.SDK_INT >= 33) {
      return intent.getParcelableExtra(
          AutofillManager.EXTRA_ASSIST_STRUCTURE, AssistStructure.class);
    }
    return intent.getParcelableExtra(AutofillManager.EXTRA_ASSIST_STRUCTURE);
  }

  private void completeAutofillAuthentication(AutofillStore store) {
    pendingAutofillAuth = false;
    AssistStructure structure = pendingAssistStructure;
    pendingAssistStructure = null;

    Intent resultIntent = new Intent();
    if (structure != null) {
      FillResponse fillResponse =
          NonePwdAutofillService.buildResponseForStructure(this, structure, store);
      if (fillResponse != null) {
        resultIntent.putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, fillResponse);
      }
    }
    setResult(Activity.RESULT_OK, resultIntent);
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

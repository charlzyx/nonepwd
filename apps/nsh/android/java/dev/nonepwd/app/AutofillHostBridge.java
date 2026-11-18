package dev.nonepwd.app;

import android.app.Activity;
import android.app.assist.AssistStructure;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.service.autofill.FillResponse;
import android.view.autofill.AutofillManager;
import org.json.JSONObject;

/**
 * Isolated Android Autofill framework bridge loaded only when Android Autofill APIs exist.
 */
public final class AutofillHostBridge {
  private AutofillHostBridge() {}

  public static JSONObject getStatus(Context context) {
    JSONObject result = new JSONObject();
    boolean supported = false;
    boolean enabled = false;
    try {
      if (Build.VERSION.SDK_INT >= 26 && context != null) {
        AutofillManager afm = context.getSystemService(AutofillManager.class);
        supported = afm != null && afm.isAutofillSupported();
        enabled = afm != null && afm.hasEnabledAutofillServices();
      }
    } catch (Throwable ignored) {
      supported = false;
      enabled = false;
    }
    try {
      result.put("available", true);
      result.put("supported", supported);
      result.put("enabled", enabled);
    } catch (Throwable ignored) {
      // Unreachable for boolean keys
    }
    return result;
  }

  public static boolean launchEnableSettings(Activity activity) {
    if (activity == null) {
      return false;
    }
    try {
      Intent intent = new Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE);
      intent.setData(Uri.parse("package:" + activity.getPackageName()));
      activity.startActivity(intent);
      return true;
    } catch (Throwable ignored) {
      try {
        Intent fallback = new Intent(Settings.ACTION_SETTINGS);
        activity.startActivity(fallback);
        return true;
      } catch (Throwable ignored2) {
        return false;
      }
    }
  }

  @SuppressWarnings("deprecation")
  public static Object extractAssistStructure(Intent intent) {
    if (intent == null || Build.VERSION.SDK_INT < 26) {
      return null;
    }
    try {
      if (Build.VERSION.SDK_INT >= 33) {
        return intent.getParcelableExtra(
            AutofillManager.EXTRA_ASSIST_STRUCTURE, AssistStructure.class);
      }
      return intent.getParcelableExtra(AutofillManager.EXTRA_ASSIST_STRUCTURE);
    } catch (Throwable ignored) {
      return null;
    }
  }

  public static void completeAuthentication(
      Activity activity, Object pendingStructure, AutofillStore store) {
    if (activity == null) {
      return;
    }
    Intent resultIntent = new Intent();
    try {
      if (pendingStructure instanceof AssistStructure && store != null) {
        FillResponse fillResponse =
            NonePwdAutofillService.buildResponseForStructure(
                activity, (AssistStructure) pendingStructure, store);
        if (fillResponse != null) {
          resultIntent.putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, fillResponse);
        }
      }
    } catch (Throwable ignored) {
      // Fall back to empty OK result
    }
    activity.setResult(Activity.RESULT_OK, resultIntent);
    activity.finish();
  }
}

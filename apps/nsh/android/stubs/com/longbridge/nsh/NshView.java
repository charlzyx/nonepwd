package com.longbridge.nsh;

import android.content.Context;
import android.content.Intent;
import android.widget.FrameLayout;
import java.io.File;

public class NshView extends FrameLayout {
  public interface HostHandler {
    void handle(Object args, NshHostReply reply);
  }

  public interface ErrorListener {
    void onError(String message);
  }

  public interface OpenUrlHandler {
    boolean openUrl(String url);
  }

  public NshView(Context context) {
    super(context);
    throw new RuntimeException("Stub");
  }

  public NshView(Context context, boolean trace) {
    super(context);
    throw new RuntimeException("Stub");
  }

  NshView(Context context, boolean trace, File filesDir, File cacheDir) {
    super(context);
    throw new RuntimeException("Stub");
  }

  void useStandaloneLimits() {
    throw new RuntimeException("Stub");
  }

  public void handle(String name, HostHandler handler) {
    throw new RuntimeException("Stub");
  }

  public boolean handleBack() {
    throw new RuntimeException("Stub");
  }

  public void handleNotificationIntent(Intent intent) {
    throw new RuntimeException("Stub");
  }

  public void handleUrlSchemeIntent(Intent intent) {
    throw new RuntimeException("Stub");
  }

  public boolean loadAssetBundle(String name) {
    throw new RuntimeException("Stub");
  }

  boolean loadAssetBundle(String name, boolean useUpdater) {
    throw new RuntimeException("Stub");
  }

  public void runRustApp(String name) {
    throw new RuntimeException("Stub");
  }

  public void destroy() {
    throw new RuntimeException("Stub");
  }

  public boolean send(String name, Object payload) {
    throw new RuntimeException("Stub");
  }

  public void setOpenUrlHandler(OpenUrlHandler handler) {
    throw new RuntimeException("Stub");
  }

  public void setErrorListener(ErrorListener listener) {
    throw new RuntimeException("Stub");
  }
}

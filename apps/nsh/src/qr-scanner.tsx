import {
  Clipboard,
  Picker,
  Scroll,
  Text,
  View,
  WebView,
  batch,
  computed,
  effect,
  signal,
  type WebViewRef,
} from "nsh";
import { Button, Input, Sheet } from "nsh/base";
import { Haptics } from "nsh/mobile";
import {
  buildOtpAuthUri,
  parseAuthenticatorExport,
  parseOtpInput,
  planTotpImport,
  type DecryptedVault,
  type TotpImportEntry,
  type TotpImportPlanItem,
  type VaultItemPayload,
} from "./crypto";
import { decodeQrFromRgba } from "./qr-cpu";

export type QrImportMode = "album" | "camera" | "text";

export interface QrScannerSheetProps {
  open: boolean;
  mode: "import" | "single";
  vaults: DecryptedVault[];
  existingItems: VaultItemPayload[];
  initialVaultId?: string;
  onApplySingle?: (entry: TotpImportEntry) => void;
  onImportPlan?: (vaultId: string, plan: TotpImportPlanItem[]) => Promise<void>;
  onClose: () => void;
}

const IMAGE_DECODER_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:transparent;">
<canvas id="c" style="display:none"></canvas>
<script>
(function() {
  var canvas = document.getElementById("c");
  var ctx = canvas.getContext("2d", { willReadFrequently: true });
  var handledIds = {};

  function postOut(obj) {
    var msg = JSON.stringify(obj);
    if (window.nsh && typeof window.nsh.postMessage === "function") {
      window.nsh.postMessage(msg);
    }
  }

  function u8ToB64(u8) {
    var chunks = [];
    for (var i = 0; i < u8.length; i += 0x8000) {
      chunks.push(String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)));
    }
    return btoa(chunks.join(""));
  }

  async function handleDecodeImage(id, dataUrl) {
    try {
      var img = new Image();
      await new Promise(function(resolve, reject) {
        img.onload = resolve;
        img.onerror = function() { reject(new Error("图片加载失败")); };
        img.src = dataUrl;
      });

      var detected = [];
      if (typeof BarcodeDetector !== "undefined") {
        try {
          var det = new BarcodeDetector({ formats: ["qr_code"] });
          var res = await det.detect(img);
          for (var i = 0; i < res.length; i++) {
            if (res[i] && typeof res[i].rawValue === "string" && res[i].rawValue.trim()) {
              detected.push(res[i].rawValue.trim());
            }
          }
        } catch (e) {}
      }

      if (detected.length > 0) {
        postOut({ type: "qr-detected", id: id, values: detected });
        return;
      }

      var maxSide = 960;
      var w = img.naturalWidth || img.width;
      var h = img.naturalHeight || img.height;
      if (w > maxSide || h > maxSide) {
        var scale = maxSide / Math.max(w, h);
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
      }
      canvas.width = w;
      canvas.height = h;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      var imgData = ctx.getImageData(0, 0, w, h);
      postOut({
        type: "image-rgba",
        id: id,
        width: w,
        height: h,
        rgbaB64: u8ToB64(imgData.data)
      });
    } catch (err) {
      postOut({ type: "image-error", id: id, message: err && err.message ? err.message : "解码失败" });
    }
  }

  function onIncoming(ev) {
    try {
      var data = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
      if (!data || !data.id || handledIds[data.id]) return;
      if (data.type === "decode-image" && data.dataUrl) {
        handledIds[data.id] = true;
        handleDecodeImage(data.id, data.dataUrl);
      }
    } catch (e) {}
  }

  window.addEventListener("message", onIncoming);
  document.addEventListener("message", onIncoming);
  postOut({ type: "decoder-ready" });
})();
</script>
</body>
</html>`;

const CAMERA_SCANNER_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>
  html,body{margin:0;padding:0;width:100%;height:100%;background:#0a0a0c;overflow:hidden;font-family:-apple-system,system-ui,sans-serif;}
  video{width:100%;height:100%;object-fit:cover;display:block;}
  .reticle{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;}
  .box{width:190px;height:190px;border:2px solid rgba(255,255,255,0.85);border-radius:16px;box-shadow:0 0 0 9999px rgba(0,0,0,0.4);}
  .status{position:absolute;bottom:10px;left:12px;right:12px;text-align:center;color:#fff;font-size:12px;text-shadow:0 1px 3px rgba(0,0,0,0.8);}
</style>
</head>
<body>
<video id="v" playsinline muted autoplay></video>
<div class="reticle"><div class="box"></div></div>
<div id="status" class="status">正在启动摄像头...</div>
<canvas id="c" style="display:none"></canvas>
<script>
(function() {
  var video = document.getElementById("v");
  var canvas = document.getElementById("c");
  var ctx = canvas.getContext("2d", { willReadFrequently: true });
  var statusEl = document.getElementById("status");
  var waitingAck = false;
  var stopped = false;
  var detector = null;
  if (typeof BarcodeDetector !== "undefined") {
    try { detector = new BarcodeDetector({ formats: ["qr_code"] }); } catch (e) {}
  }

  function postOut(obj) {
    if (window.nsh && typeof window.nsh.postMessage === "function") {
      window.nsh.postMessage(JSON.stringify(obj));
    }
  }

  function u8ToB64(u8) {
    var chunks = [];
    for (var i = 0; i < u8.length; i += 0x8000) {
      chunks.push(String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)));
    }
    return btoa(chunks.join(""));
  }

  function onIncoming(ev) {
    try {
      var d = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
      if (d && d.type === "frame-ack") waitingAck = false;
      if (d && d.type === "stop") stopped = true;
    } catch (e) {}
  }
  window.addEventListener("message", onIncoming);
  document.addEventListener("message", onIncoming);

  async function start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      statusEl.textContent = "当前设备不支持摄像头扫码，请使用相册选图或粘贴导入";
      postOut({ type: "camera-error", message: "当前设备不支持 WebView 摄像头 (getUserMedia)" });
      return;
    }
    try {
      var stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      } catch (e) {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      video.srcObject = stream;
      await video.play();
      statusEl.textContent = "请将 2FA 二维码置于框内";

      var timer = setInterval(async function() {
        if (stopped) {
          clearInterval(timer);
          stream.getTracks().forEach(function(t) { t.stop(); });
          return;
        }
        if (waitingAck || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
        waitingAck = true;
        try {
          if (detector) {
            var found = await detector.detect(video);
            if (found && found.length > 0) {
              var vals = [];
              for (var i = 0; i < found.length; i++) {
                if (found[i] && found[i].rawValue) vals.push(found[i].rawValue.trim());
              }
              if (vals.length > 0) {
                postOut({ type: "qr-detected", values: vals });
                return;
              }
            }
          }
          var targetW = Math.min(480, video.videoWidth);
          var scale = targetW / video.videoWidth;
          var targetH = Math.max(1, Math.round(video.videoHeight * scale));
          canvas.width = targetW;
          canvas.height = targetH;
          ctx.drawImage(video, 0, 0, targetW, targetH);
          var imgData = ctx.getImageData(0, 0, targetW, targetH);
          postOut({
            type: "camera-frame",
            width: targetW,
            height: targetH,
            rgbaB64: u8ToB64(imgData.data)
          });
        } catch (err) {
          waitingAck = false;
        }
      }, 280);
    } catch (err) {
      var msg = err && err.message ? err.message : "摄像头权限被拒绝或不可用";
      statusEl.textContent = msg;
      postOut({ type: "camera-error", message: msg });
    }
  }
  start();
})();
</script>
</body>
</html>`;

export function parseImportInputText(raw: string): TotpImportEntry[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("请先粘贴 otpauth:// 链接、迁移二维码文本或 Base32 密钥");
  }
  try {
    return parseAuthenticatorExport(trimmed);
  } catch (exportErr) {
    // Allow raw Base32 secret fallback for quick manual paste
    try {
      const parsed = parseOtpInput(trimmed);
      const uri = buildOtpAuthUri({
        secret: parsed.secret,
        issuer: parsed.issuer,
        account: parsed.account,
        digits: parsed.digits,
        period: parsed.period,
        algorithm: parsed.algorithm,
      });
      return [
        {
          ...(parsed.issuer ? { issuer: parsed.issuer } : {}),
          ...(parsed.account ? { account: parsed.account } : {}),
          secret: parsed.secret,
          otpauthUri: uri,
          digits: parsed.digits,
          period: parsed.period,
          algorithm: parsed.algorithm,
        },
      ];
    } catch {
      throw exportErr;
    }
  }
}

export function extractOtpPayloadsFromQrStrings(rawValues: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawValues) {
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      const lower = t.toLowerCase();
      if (
        lower.startsWith("otpauth://") ||
        lower.startsWith("otpauth-migration://")
      ) {
        if (!seen.has(t)) {
          seen.add(t);
          out.push(t);
        }
      } else {
        try {
          parseOtpInput(t);
          if (!seen.has(t)) {
            seen.add(t);
            out.push(t);
          }
        } catch {
          // Ignore non-OTP lines
        }
      }
    }
  }
  return out;
}

export function QrScannerSheet(props: QrScannerSheetProps) {
  const activeMode = signal<QrImportMode>("album");
  const pasteText = signal("");
  const entries = signal<TotpImportEntry[]>([]);
  const targetVaultId = signal(props.initialVaultId || props.vaults[0]?.id || "");
  const busy = signal(false);
  const importing = signal(false);
  const statusMsg = signal<{ kind: "ok" | "error" | "info"; text: string } | null>(null);
  const webViewCapable = signal(true);

  let decoderWebViewRef: WebViewRef | undefined;
  let cameraWebViewRef: WebViewRef | undefined;
  let decoderReady = false;
  let pendingQueue: Array<{ id: string; dataUrl: string }> = [];
  let pendingWaiters = new Map<string, (values: string[]) => void>();
  let requestCounter = 0;

  effect(() => {
    if (props.open) {
      batch(() => {
        statusMsg.set(null);
        entries.set([]);
        pasteText.set("");
        if (!targetVaultId() && props.vaults.length > 0) {
          targetVaultId.set(props.initialVaultId || props.vaults[0].id);
        } else if (props.initialVaultId) {
          targetVaultId.set(props.initialVaultId);
        }
      });
      void WebView.available()
        .then((ok) => webViewCapable.set(ok))
        .catch(() => webViewCapable.set(false));
    } else {
      decoderReady = false;
      pendingQueue = [];
      pendingWaiters.clear();
    }
  });

  const importPlan = computed<TotpImportPlanItem[]>(() => {
    const list = entries();
    if (list.length === 0) return [];
    const vid = targetVaultId();
    const vaultItems = props.existingItems.filter((it) => !vid || it.vaultId === vid);
    return planTotpImport(vaultItems, list);
  });

  function applyDecodedStrings(rawValues: string[], sourceLabel: string) {
    const otpLines = extractOtpPayloadsFromQrStrings(rawValues);
    if (otpLines.length === 0) {
      statusMsg.set({
        kind: "error",
        text:
          rawValues.length > 0
            ? `${sourceLabel}识别到二维码，但内容不是有效的 otpauth:// 或迁移链接`
            : `${sourceLabel}未检测到有效 2FA 二维码，请尝试裁剪清晰截图或直接粘贴密钥`,
      });
      return false;
    }
    try {
      const parsed = parseImportInputText(otpLines.join("\n"));
      batch(() => {
        entries.set(parsed);
        pasteText.set(otpLines.join("\n"));
        statusMsg.set({
          kind: "ok",
          text: `${sourceLabel}成功解析 ${parsed.length} 个 2FA 密钥`,
        });
      });
      Haptics.notification("success");
      return true;
    } catch (err) {
      statusMsg.set({
        kind: "error",
        text: err instanceof Error ? err.message : "解析 2FA 内容失败",
      });
      return false;
    }
  }

  function handleDecoderMessage(raw: string) {
    let msg: {
      type?: string;
      id?: string;
      values?: string[];
      width?: number;
      height?: number;
      rgbaB64?: string;
      message?: string;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "decoder-ready") {
      decoderReady = true;
      for (const item of pendingQueue) {
        decoderWebViewRef?.postMessage(
          JSON.stringify({ type: "decode-image", id: item.id, dataUrl: item.dataUrl })
        );
      }
      pendingQueue = [];
      return;
    }
    if (!msg.id) return;
    const waiter = pendingWaiters.get(msg.id);
    if (!waiter) return;
    pendingWaiters.delete(msg.id);

    if (msg.type === "qr-detected") {
      waiter(msg.values ?? []);
    } else if (msg.type === "image-rgba" && msg.rgbaB64 && msg.width && msg.height) {
      const buf = Buffer.from(msg.rgbaB64, "base64");
      const rgba = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      const decoded = decodeQrFromRgba(rgba, msg.width, msg.height);
      waiter(decoded);
    } else {
      waiter([]);
    }
  }

  function decodeImageViaWebView(dataUrl: string): Promise<string[]> {
    return new Promise((resolve) => {
      const id = `qr_${++requestCounter}`;
      const timer = setTimeout(() => {
        pendingWaiters.delete(id);
        resolve([]);
      }, 8000);
      pendingWaiters.set(id, (vals) => {
        clearTimeout(timer);
        resolve(vals);
      });
      if (decoderReady && decoderWebViewRef) {
        decoderWebViewRef.postMessage(JSON.stringify({ type: "decode-image", id, dataUrl }));
      } else {
        pendingQueue.push({ id, dataUrl });
      }
    });
  }

  async function handlePickImages() {
    if (busy()) return;
    busy.set(true);
    statusMsg.set({ kind: "info", text: "正在打开系统相册..." });
    try {
      const picked = await Picker.pickImages({
        multiple: true,
        maxDimension: 1200,
        format: "compatible",
      });
      if (picked.length === 0) {
        statusMsg.set(null);
        return;
      }
      if (!webViewCapable()) {
        statusMsg.set({
          kind: "error",
          text: "当前运行环境不支持相册图片像素解码，请粘贴 otpauth:// 文本导入",
        });
        return;
      }
      statusMsg.set({ kind: "info", text: `正在离线识别 ${picked.length} 张二维码图片...` });
      const allValues: string[] = [];
      for (const item of picked) {
        const ab = await item.file.arrayBuffer();
        const b64 = Buffer.from(ab).toString("base64");
        const mime = item.file.type || "image/png";
        const dataUrl = `data:${mime};base64,${b64}`;
        const vals = await decodeImageViaWebView(dataUrl);
        for (const v of vals) {
          if (!allValues.includes(v)) allValues.push(v);
        }
      }
      applyDecodedStrings(allValues, "相册图片");
    } catch (err) {
      statusMsg.set({
        kind: "error",
        text: err instanceof Error ? err.message : "相册选图识别失败",
      });
    } finally {
      busy.set(false);
    }
  }

  function handleCameraMessage(raw: string) {
    let msg: {
      type?: string;
      values?: string[];
      width?: number;
      height?: number;
      rgbaB64?: string;
      message?: string;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "camera-error") {
      statusMsg.set({
        kind: "error",
        text: msg.message || "无法启用摄像头，请改用「相册选图」或「粘贴导入」",
      });
      return;
    }
    if (msg.type === "qr-detected" && msg.values) {
      const ok = applyDecodedStrings(msg.values, "摄像头扫码");
      if (ok) {
        cameraWebViewRef?.postMessage(JSON.stringify({ type: "stop" }));
        activeMode.set("text");
      } else {
        cameraWebViewRef?.postMessage(JSON.stringify({ type: "frame-ack" }));
      }
      return;
    }
    if (msg.type === "camera-frame" && msg.rgbaB64 && msg.width && msg.height) {
      const buf = Buffer.from(msg.rgbaB64, "base64");
      const rgba = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      const decoded = decodeQrFromRgba(rgba, msg.width, msg.height);
      if (decoded.length > 0 && applyDecodedStrings(decoded, "摄像头扫码")) {
        cameraWebViewRef?.postMessage(JSON.stringify({ type: "stop" }));
        activeMode.set("text");
      } else {
        cameraWebViewRef?.postMessage(JSON.stringify({ type: "frame-ack" }));
      }
    }
  }

  async function handleReadClipboard() {
    statusMsg.set(null);
    try {
      const text = (await Clipboard.readText()).trim();
      if (!text) {
        statusMsg.set({ kind: "error", text: "剪贴板为空，请先复制 otpauth:// 链接或导出内容" });
        return;
      }
      pasteText.set(text);
      const parsed = parseImportInputText(text);
      entries.set(parsed);
      statusMsg.set({
        kind: "ok",
        text: `已从剪贴板识别 ${parsed.length} 个 2FA 密钥`,
      });
      Haptics.notification("success");
    } catch (err) {
      statusMsg.set({
        kind: "error",
        text: err instanceof Error ? err.message : "未能从剪贴板解析出有效的 2FA 内容",
      });
    }
  }

  function handleParseManualText() {
    statusMsg.set(null);
    try {
      const parsed = parseImportInputText(pasteText());
      entries.set(parsed);
      statusMsg.set({
        kind: "ok",
        text: `解析成功，共 ${parsed.length} 个 2FA 条目`,
      });
      Haptics.selection();
    } catch (err) {
      entries.set([]);
      statusMsg.set({
        kind: "error",
        text: err instanceof Error ? err.message : "无法解析 2FA 内容",
      });
    }
  }

  async function handleConfirm() {
    const list = entries();
    if (list.length === 0) return;
    if (props.mode === "single") {
      props.onApplySingle?.(list[0]);
      props.onClose();
      return;
    }
    const vid = targetVaultId() || props.vaults[0]?.id;
    if (!vid || !props.onImportPlan) return;
    importing.set(true);
    try {
      await props.onImportPlan(vid, importPlan());
      props.onClose();
    } catch (err) {
      statusMsg.set({
        kind: "error",
        text: err instanceof Error ? err.message : "导入 2FA 条目失败",
      });
    } finally {
      importing.set(false);
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
        {/* Sheet Header */}
        <View class="flex-row items-center justify-between">
          <View class="gap-0.5">
            <Text class="text-lg font-semibold text-foreground">
              {props.mode === "single" ? "添加 2FA 密钥" : "导入 2FA 验证器"}
            </Text>
            <Text class="text-xs text-muted-foreground">
              支持相册二维码、摄像头扫码、Google 迁移与 otpauth:// 文本
            </Text>
          </View>
          <Button
            onPress={props.onClose}
            class="rounded-full bg-muted px-3 py-1.5 active:opacity-75"
          >
            <Text class="text-xs font-medium text-foreground">关闭</Text>
          </Button>
        </View>

        {/* Mode Switcher */}
        <View class="flex-row gap-1.5 rounded-xl bg-muted p-1">
          <Button
            onPress={() => {
              Haptics.selection();
              activeMode.set("album");
            }}
            class={`flex-1 items-center rounded-lg py-2 ${
              activeMode() === "album" ? "bg-card" : ""
            }`}
          >
            <Text
              class={`text-xs font-medium ${
                activeMode() === "album" ? "text-foreground" : "text-muted-foreground"
              }`}
            >
              相册选图
            </Text>
          </Button>
          <Button
            onPress={() => {
              Haptics.selection();
              activeMode.set("camera");
            }}
            class={`flex-1 items-center rounded-lg py-2 ${
              activeMode() === "camera" ? "bg-card" : ""
            }`}
          >
            <Text
              class={`text-xs font-medium ${
                activeMode() === "camera" ? "text-foreground" : "text-muted-foreground"
              }`}
            >
              摄像头扫码
            </Text>
          </Button>
          <Button
            onPress={() => {
              Haptics.selection();
              activeMode.set("text");
            }}
            class={`flex-1 items-center rounded-lg py-2 ${
              activeMode() === "text" ? "bg-card" : ""
            }`}
          >
            <Text
              class={`text-xs font-medium ${
                activeMode() === "text" ? "text-foreground" : "text-muted-foreground"
              }`}
            >
              粘贴 / 文本
            </Text>
          </Button>
        </View>

        {/* Hidden WebView decoder for Picker images */}
        <If when={props.open && webViewCapable()}>
          <View class="h-0 w-0 overflow-hidden opacity-0">
            <WebView
              ref={(r) => {
                decoderWebViewRef = r;
              }}
              html={IMAGE_DECODER_HTML}
              javaScriptEnabled
              onMessage={(e) => handleDecoderMessage(e.data)}
              onError={() => webViewCapable.set(false)}
            />
          </View>
        </If>

        <Scroll class="max-h-[420px]" contentClass="gap-3 pb-2">
          {/* Mode 1: Photo Album Picker */}
          <If when={activeMode() === "album"}>
            <View class="gap-3 rounded-xl border border-border bg-background p-4">
              <Text class="text-xs text-muted-foreground">
                从手机或电脑相册选择一张或多张 2FA 二维码截图（支持 Google Authenticator 批量导出二维码），完全本地离线解码。
              </Text>
              <Button
                disabled={busy()}
                onPress={() => void handlePickImages()}
                class="items-center rounded-xl bg-primary py-3 active:opacity-85 disabled:opacity-50"
              >
                <Text class="text-sm font-semibold text-primary-foreground">
                  {busy() ? "正在离线识别..." : "从相册选择二维码图片"}
                </Text>
              </Button>
            </View>
          </If>

          {/* Mode 2: Live Camera Scanner */}
          <If when={activeMode() === "camera"}>
            <View class="gap-2 rounded-xl border border-border bg-background p-3">
              <If
                when={webViewCapable()}
                else={
                  <View class="items-center gap-2 py-6">
                    <Text class="text-xs text-muted-foreground">
                      当前环境不支持 WebView 摄像头，请使用「相册选图」或「粘贴 / 文本」。
                    </Text>
                  </View>
                }
              >
                <View class="h-56 w-full overflow-hidden rounded-xl bg-black">
                  <WebView
                    ref={(r) => {
                      cameraWebViewRef = r;
                    }}
                    html={CAMERA_SCANNER_HTML}
                    javaScriptEnabled
                    onMessage={(e) => handleCameraMessage(e.data)}
                    onError={(e) =>
                      statusMsg.set({
                        kind: "error",
                        text: e.message || "摄像头扫码组件加载失败",
                      })
                    }
                  />
                </View>
              </If>
            </View>
          </If>

          {/* Mode 3: Clipboard / Text Import */}
          <If when={activeMode() === "text"}>
            <View class="gap-2.5 rounded-xl border border-border bg-background p-3">
              <View class="flex-row items-center justify-between gap-2">
                <Text class="text-xs font-medium text-foreground">
                  粘贴 otpauth:// 链接、迁移 URI 或 Base32 密钥
                </Text>
                <Button
                  onPress={() => void handleReadClipboard()}
                  class="rounded-lg border border-border bg-card px-2.5 py-1.5 active:bg-muted"
                >
                  <Text class="text-xs font-medium text-foreground">读取剪贴板</Text>
                </Button>
              </View>
              <Input
                testID="qr-paste-input"
                value={pasteText()}
                onChange={(e) => pasteText.set(e.value)}
                multiline
                placeholder="otpauth://totp/GitHub:alice?secret=... 或 otpauth-migration://offline?data=..."
                class="h-24 rounded-lg border border-input bg-card p-2.5 text-xs text-foreground"
              />
              <Button
                onPress={handleParseManualText}
                class="items-center rounded-lg border border-border bg-card py-2 active:bg-muted"
              >
                <Text class="text-xs font-semibold text-foreground">解析预览</Text>
              </Button>
            </View>
          </If>

          {/* Status Feedback */}
          <If when={statusMsg()}>
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
                    msg().kind === "error"
                      ? "text-destructive"
                      : "text-foreground"
                  }`}
                >
                  {msg().text}
                </Text>
              </View>
            )}
          </If>

          {/* Parsed Entries Preview */}
          <If when={entries().length > 0}>
            <View class="gap-2 rounded-xl border border-border bg-background p-3">
              <If when={props.mode === "import" && props.vaults.length > 0}>
                <View class="gap-1.5">
                  <Text class="text-xs font-medium text-muted-foreground">导入目标保险库</Text>
                  <View class="flex-row flex-wrap gap-1.5">
                    <Each of={props.vaults}>
                      {(v) => (
                        <Button
                          onPress={() => targetVaultId.set(v().id)}
                          class={`rounded-full border px-3 py-1 ${
                            targetVaultId() === v().id
                              ? "border-primary bg-primary"
                              : "border-border bg-card"
                          }`}
                        >
                          <Text
                            class={`text-xs font-medium ${
                              targetVaultId() === v().id
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

              <Text class="text-xs font-semibold text-foreground">
                待导入条目 ({entries().length})
              </Text>
              <Each of={importPlan()}>
                {(step) => (
                  <View class="flex-row items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2">
                    <View class="flex-1 gap-0.5">
                      <Text class="text-xs font-semibold text-foreground">
                        {step().entry.issuer || step().entry.account || "2FA 账号"}
                      </Text>
                      <If when={step().entry.account}>
                        <Text class="text-[11px] text-muted-foreground">
                          {step().entry.account}
                        </Text>
                      </If>
                    </View>
                    <View class="rounded-full bg-muted px-2 py-0.5">
                      <Text class="text-[10px] font-medium text-foreground">
                        {step().action === "skip_duplicate"
                          ? "跳过重复"
                          : step().action === "attach"
                            ? "绑定已有登录"
                            : "新建条目"}
                      </Text>
                    </View>
                  </View>
                )}
              </Each>
            </View>
          </If>
        </Scroll>

        {/* Confirm Button */}
        <If when={entries().length > 0}>
          <Button
            disabled={importing()}
            onPress={() => void handleConfirm()}
            class="items-center rounded-xl bg-primary py-3 active:opacity-85 disabled:opacity-50"
          >
            <Text class="text-sm font-semibold text-primary-foreground">
              {importing()
                ? "正在加密保存..."
                : props.mode === "single"
                  ? "填入此 2FA 密钥"
                  : `确认导入 (${entries().length} 条)`}
            </Text>
          </Button>
        </If>
      </View>
    </Sheet>
  );
}

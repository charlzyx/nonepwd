package dev.nonepwd.app;

import android.net.Uri;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.Locale;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Offline RFC 6238 TOTP generator supporting otpauth:// URIs and raw Base32 secrets. */
public final class TotpHelper {
  private TotpHelper() {}

  public static String generate(String secretOrUri) {
    return generate(secretOrUri, System.currentTimeMillis());
  }

  public static String generate(String secretOrUri, long timeMs) {
    if (secretOrUri == null) {
      return null;
    }
    String raw = secretOrUri.trim();
    if (raw.isEmpty()) {
      return null;
    }

    String secret = raw;
    String algorithm = "HmacSHA1";
    int digits = 6;
    int period = 30;

    if (raw.toLowerCase(Locale.US).startsWith("otpauth://")) {
      Uri uri;
      try {
        uri = Uri.parse(raw);
      } catch (Throwable ignored) {
        return null;
      }
      String type = uri.getAuthority();
      if (type == null || !"totp".equalsIgnoreCase(type)) {
        return null;
      }
      secret = getQueryParamRaw(uri, "secret");
      if (secret == null || secret.trim().isEmpty()) {
        return null;
      }
      String algParam = getQueryParamRaw(uri, "algorithm");
      if (algParam != null) {
        String normAlg = algParam.trim().toUpperCase(Locale.US);
        if ("SHA256".equals(normAlg) || "HMACSHA256".equals(normAlg)) {
          algorithm = "HmacSHA256";
        } else if ("SHA512".equals(normAlg) || "HMACSHA512".equals(normAlg)) {
          algorithm = "HmacSHA512";
        } else if ("SHA1".equals(normAlg) || "HMACSHA1".equals(normAlg)) {
          algorithm = "HmacSHA1";
        }
      }
      String digitsParam = getQueryParamRaw(uri, "digits");
      if (digitsParam != null) {
        try {
          int parsedDigits = Integer.parseInt(digitsParam.trim());
          if (parsedDigits >= 4 && parsedDigits <= 10) {
            digits = parsedDigits;
          }
        } catch (NumberFormatException ignored) {
          // Keep default 6 digits
        }
      }
      String periodParam = getQueryParamRaw(uri, "period");
      if (periodParam != null) {
        try {
          int parsedPeriod = Integer.parseInt(periodParam.trim());
          if (parsedPeriod > 0 && parsedPeriod <= 3600) {
            period = parsedPeriod;
          }
        } catch (NumberFormatException ignored) {
          // Keep default 30s period
        }
      }
    }

    byte[] keyBytes = decodeBase32(secret);
    if (keyBytes == null || keyBytes.length == 0) {
      return null;
    }

    long counter = Math.max(0L, timeMs / 1000L) / period;
    byte[] msg = ByteBuffer.allocate(8).putLong(counter).array();
    try {
      Mac mac = Mac.getInstance(algorithm);
      mac.init(new SecretKeySpec(keyBytes, algorithm));
      byte[] hash = mac.doFinal(msg);
      if (hash.length < 4) {
        return null;
      }
      int offset = hash[hash.length - 1] & 0x0F;
      if (offset + 3 >= hash.length) {
        return null;
      }
      int binary =
          ((hash[offset] & 0x7F) << 24)
              | ((hash[offset + 1] & 0xFF) << 16)
              | ((hash[offset + 2] & 0xFF) << 8)
              | (hash[offset + 3] & 0xFF);
      long mod = 1L;
      for (int i = 0; i < digits; i++) {
        mod *= 10L;
      }
      long otp = (binary & 0x7FFFFFFFL) % mod;
      return String.format(Locale.US, "%0" + digits + "d", otp);
    } catch (Throwable ignored) {
      return null;
    }
  }

  private static String getQueryParamRaw(Uri uri, String key) {
    try {
      String val = uri.getQueryParameter(key);
      if (val != null) {
        return val;
      }
    } catch (Throwable ignored) {
      // Fall through to case-insensitive scan
    }
    try {
      for (String name : uri.getQueryParameterNames()) {
        if (key.equalsIgnoreCase(name)) {
          return uri.getQueryParameter(name);
        }
      }
    } catch (Throwable ignored) {
      // Ignore malformed query string
    }
    return null;
  }

  private static byte[] decodeBase32(String input) {
    if (input == null) {
      return null;
    }
    String normalized = input.toUpperCase(Locale.US).replaceAll("[\\s=-]", "");
    if (normalized.isEmpty()) {
      return null;
    }
    ByteArrayOutputStream out = new ByteArrayOutputStream((normalized.length() * 5) / 8 + 1);
    int buffer = 0;
    int bitsLeft = 0;
    for (int i = 0; i < normalized.length(); i++) {
      char c = normalized.charAt(i);
      int val;
      if (c >= 'A' && c <= 'Z') {
        val = c - 'A';
      } else if (c >= '2' && c <= '7') {
        val = 26 + (c - '2');
      } else {
        return null;
      }
      buffer = (buffer << 5) | val;
      bitsLeft += 5;
      if (bitsLeft >= 8) {
        out.write((buffer >> (bitsLeft - 8)) & 0xFF);
        bitsLeft -= 8;
      }
    }
    return out.toByteArray();
  }
}

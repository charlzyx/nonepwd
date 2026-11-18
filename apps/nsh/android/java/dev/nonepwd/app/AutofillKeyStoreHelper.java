package dev.nonepwd.app;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.io.IOException;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;

/**
 * Isolated AndroidKeyStore helper loaded only when Android KeyStore APIs are available.
 */
public final class AutofillKeyStoreHelper {
  private static final String KEYSTORE_PROVIDER = "AndroidKeyStore";
  private static final String KEY_ALIAS = "nonepwd_autofill_aes";

  private AutofillKeyStoreHelper() {}

  public static SecretKey getOrCreateSecretKey(boolean forceRecreate)
      throws GeneralSecurityException, IOException {
    KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
    keyStore.load(null);
    if (forceRecreate && keyStore.containsAlias(KEY_ALIAS)) {
      keyStore.deleteEntry(KEY_ALIAS);
    }
    if (!forceRecreate && keyStore.containsAlias(KEY_ALIAS)) {
      KeyStore.Entry entry = keyStore.getEntry(KEY_ALIAS, null);
      if (entry instanceof KeyStore.SecretKeyEntry) {
        return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
      }
      keyStore.deleteEntry(KEY_ALIAS);
    }

    KeyGenerator keyGenerator =
        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER);
    KeyGenParameterSpec spec =
        new KeyGenParameterSpec.Builder(
                KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build();
    keyGenerator.init(spec);
    return keyGenerator.generateKey();
  }

  public static SecretKey loadExistingSecretKey() throws GeneralSecurityException, IOException {
    KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
    keyStore.load(null);
    if (!keyStore.containsAlias(KEY_ALIAS)) {
      return null;
    }
    KeyStore.Entry entry = keyStore.getEntry(KEY_ALIAS, null);
    if (!(entry instanceof KeyStore.SecretKeyEntry)) {
      return null;
    }
    return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
  }
}

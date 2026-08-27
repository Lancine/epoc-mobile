package ci.epro.geniia.technopedagogie.niveau1;

import android.content.Context;
import android.content.SharedPreferences;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Stockage local chiffré de l'activation.
 *
 * Les numéros de série ne sont jamais embarqués en clair : l'application ne
 * conserve que les 128 premiers bits de leur empreinte SHA-256 dans un fichier
 * d'actifs. Les activations déjà enregistrées par la version 2.1 restent valides.
 */
final class ActivationStore {
    private static final String PREFS = "epro_activation_v1";
    private static final String RECORD = "activation_record";
    private static final String KEY_ALIAS = "epro_technopedagogie_activation_key_v1";
    private static final String PREFIXES_ASSET = "serial_hash_prefixes.txt";

    private final Context context;
    private final SharedPreferences preferences;
    private volatile Set<String> validPrefixes;

    ActivationStore(Context context) {
        this.context = context.getApplicationContext();
        this.preferences = this.context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    synchronized boolean activate(String serialInput) {
        String serial = normalizeSerial(serialInput);
        if (serial.length() != 24) return false;

        String fullHash = sha256(serial);
        if (!isValidHash(fullHash)) return false;
        if (isActivated()) return true;

        try {
            String payload = fullHash + "|" + deviceBinding();
            boolean saved = preferences.edit().putString(RECORD, encrypt(payload)).commit();
            return saved && isActivated();
        } catch (Exception error) {
            preferences.edit().remove(RECORD).commit();
            return false;
        }
    }

    synchronized boolean isActivated() {
        String record = preferences.getString(RECORD, null);
        if (record == null || record.isEmpty()) return false;

        try {
            String payload = decrypt(record);
            String[] parts = payload.split("\\|", 2);
            return parts.length == 2
                    && isValidHash(parts[0])
                    && MessageDigest.isEqual(
                        parts[1].getBytes(StandardCharsets.UTF_8),
                        deviceBinding().getBytes(StandardCharsets.UTF_8));
        } catch (Exception error) {
            preferences.edit().remove(RECORD).apply();
            return false;
        }
    }

    private boolean isValidHash(String hash) {
        if (hash == null) return false;
        String clean = hash.toLowerCase(Locale.ROOT).trim();
        if (clean.length() < 32) return false;
        return prefixes().contains(clean.substring(0, 32));
    }

    private Set<String> prefixes() {
        Set<String> cached = validPrefixes;
        if (cached != null) return cached;

        synchronized (this) {
            if (validPrefixes != null) return validPrefixes;
            Set<String> loaded = new HashSet<>();
            try (InputStream input = context.getAssets().open(PREFIXES_ASSET);
                 BufferedReader reader = new BufferedReader(
                         new InputStreamReader(input, StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    String value = line.trim().toLowerCase(Locale.ROOT);
                    if (value.matches("[0-9a-f]{32}")) loaded.add(value);
                }
            } catch (Exception ignored) {
                // Une liste vide provoque un refus propre de toute activation.
            }
            validPrefixes = Collections.unmodifiableSet(loaded);
            return validPrefixes;
        }
    }

    private String deviceBinding() {
        String androidId = Settings.Secure.getString(
                context.getContentResolver(), Settings.Secure.ANDROID_ID);
        if (androidId == null || androidId.isEmpty()) androidId = "unknown-device";
        return sha256(context.getPackageName() + "|" + androidId);
    }

    private String encrypt(String clearText) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, secretKey());
        byte[] encrypted = cipher.doFinal(clearText.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "."
                + Base64.encodeToString(encrypted, Base64.NO_WRAP);
    }

    private String decrypt(String record) throws Exception {
        String[] parts = record.split("\\.", 2);
        if (parts.length != 2) throw new IllegalArgumentException("Invalid activation record");
        byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
        byte[] encrypted = Base64.decode(parts[1], Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
    }

    private SecretKey secretKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) {
            KeyStore.Entry entry = store.getEntry(KEY_ALIAS, null);
            if (entry instanceof KeyStore.SecretKeyEntry) {
                return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
            }
            store.deleteEntry(KEY_ALIAS);
        }

        KeyGenerator generator = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }

    private static String normalizeSerial(String value) {
        if (value == null) return "";
        return value.toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9]", "");
    }

    private static String sha256(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder output = new StringBuilder(bytes.length * 2);
            for (byte item : bytes) {
                output.append(String.format(Locale.ROOT, "%02x", item & 0xff));
            }
            return output.toString();
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }
}

package ci.epro.geniia.technopedagogie.niveau1;

import android.content.Context;
import android.content.SharedPreferences;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class ActivationStore {
    private static final String PREFS = "epro_activation_v1";
    private static final String RECORD = "record";
    private static final String KEY_ALIAS = "epro_activation_key_v1";

    private final Context context;
    private final SharedPreferences preferences;
    private final Set<String> allowedPrefixes = new HashSet<>();

    ActivationStore(Context context) {
        this.context = context.getApplicationContext();
        this.preferences = this.context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        loadAllowedPrefixes();
    }

    synchronized boolean activate(String input) {
        String serial = normalize(input);
        if (serial.length() != 24) return false;
        String digest = hex(sha256(serial));
        if (!allowedPrefixes.contains(digest.substring(0, 32))) return false;
        if (isActivated()) return true;
        try {
            String payload = digest + "|" + deviceBinding();
            if (!preferences.edit().putString(RECORD, encrypt(payload)).commit()) return false;
            return isActivated();
        } catch (Exception error) {
            preferences.edit().remove(RECORD).commit();
            return false;
        }
    }

    synchronized boolean isActivated() {
        String record = preferences.getString(RECORD, null);
        if (record == null || record.isEmpty()) return false;
        try {
            String[] values = decrypt(record).split("\\|", 2);
            if (values.length != 2 || !values[1].equals(deviceBinding())) return false;
            String digest = values[0].toLowerCase(Locale.ROOT);
            return digest.length() == 64 && allowedPrefixes.contains(digest.substring(0, 32));
        } catch (Exception error) {
            preferences.edit().remove(RECORD).apply();
            return false;
        }
    }

    private void loadAllowedPrefixes() {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                context.getAssets().open("serial_hash_prefixes.txt"), StandardCharsets.US_ASCII))) {
            String line;
            while ((line = reader.readLine()) != null) {
                String value = line.trim().toLowerCase(Locale.ROOT);
                if (value.matches("[0-9a-f]{32}")) allowedPrefixes.add(value);
            }
        } catch (Exception ignored) {
            allowedPrefixes.clear();
        }
    }

    private String deviceBinding() {
        String id = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ANDROID_ID);
        if (id == null || id.isEmpty()) id = "unknown-device";
        return hex(sha256(context.getPackageName() + "|" + id));
    }

    private String encrypt(String clear) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        String iv = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP);
        String data = Base64.encodeToString(cipher.doFinal(clear.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
        return iv + "." + data;
    }

    private String decrypt(String record) throws Exception {
        String[] values = record.split("\\.", 2);
        if (values.length != 2) throw new IllegalArgumentException("Invalid activation record");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(),
                new GCMParameterSpec(128, Base64.decode(values[0], Base64.NO_WRAP)));
        return new String(cipher.doFinal(Base64.decode(values[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) store.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }

    private static String normalize(String value) {
        return value == null ? "" : value.toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9]", "");
    }

    private static byte[] sha256(String value) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        } catch (Exception impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder output = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) output.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return output.toString();
    }
}

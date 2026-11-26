package com.khalidpharmacy.app.plugins;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.provider.MediaStore;
import android.util.Base64;

import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;

import androidx.annotation.NonNull;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Offline, still-image medicine label OCR bridge.
 * Camera capture is delegated to the Android system camera activity only after
 * the TypeScript coordinator has stopped the existing barcode scanner.
 */
@CapacitorPlugin(name = "MedicineTextRecognition")
public class MedicineTextRecognitionPlugin extends Plugin {
    private static final int MAX_BASE64_CHARS = 16 * 1024 * 1024;
    private static final int MAX_IMAGE_EDGE = 2400;

    private TextRecognizer recognizer;
    private ExecutorService executor;
    private final AtomicBoolean captureInProgress = new AtomicBoolean(false);
    private volatile File pendingCaptureFile;

    @Override
    public void load() {
        recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
        executor = Executors.newSingleThreadExecutor();
    }

    /**
     * Launch one system-camera still capture and run OCR on the returned file.
     * The existing CameraX barcode scanner must be stopped by the caller first.
     */
    @PluginMethod
    public void captureAndRecognize(PluginCall call) {
        if (!captureInProgress.compareAndSet(false, true)) {
            call.reject("A medicine image capture is already in progress");
            return;
        }

        File output = new File(getContext().getCacheDir(), "medicine-ocr-" + UUID.randomUUID() + ".jpg");
        try {
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            Uri outputUri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                output
            );
            intent.putExtra(MediaStore.EXTRA_OUTPUT, outputUri);
            intent.setClipData(ClipData.newRawUri("medicine-image", outputUri));
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            pendingCaptureFile = output;
            startActivityForResult(call, intent, "captureMedicineImageResult");
        } catch (Exception error) {
            output.delete();
            pendingCaptureFile = null;
            captureInProgress.set(false);
            call.reject("Unable to open the camera for medicine recognition", error);
        }
    }

    @ActivityCallback
    private void captureMedicineImageResult(PluginCall call, ActivityResult result) {
        File captured = pendingCaptureFile;

        if (call == null) {
            finishCapture(captured);
            return;
        }

        if (result.getResultCode() != Activity.RESULT_OK) {
            finishCapture(captured);
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }

        if (captured == null || !captured.isFile() || captured.length() <= 0) {
            finishCapture(captured);
            call.reject("The camera did not return a usable image");
            return;
        }
        if (captured.length() > 24L * 1024L * 1024L) {
            finishCapture(captured);
            call.reject("Captured image exceeds the 24 MB processing limit");
            return;
        }

        executor.execute(() -> {
            try {
                InputImage inputImage = InputImage.fromFilePath(getContext(), Uri.fromFile(captured));
                recognizer.process(inputImage)
                    .addOnSuccessListener(text -> {
                        Bitmap capturedBitmap = null;
                        try {
                            JSObject response = toJsResult(text);
                            byte[] originalBytes = readFileBytes(captured);
                            capturedBitmap = decodeScaledBitmap(originalBytes);
                            if (capturedBitmap == null) {
                                throw new IllegalStateException("Unable to decode the captured image for review");
                            }
                            ByteArrayOutputStream imageOutput = new ByteArrayOutputStream();
                            if (!capturedBitmap.compress(Bitmap.CompressFormat.JPEG, 82, imageOutput)) {
                                throw new IllegalStateException("Unable to encode the captured image for review");
                            }
                            String imageBase64 = Base64.encodeToString(imageOutput.toByteArray(), Base64.NO_WRAP);
                            if (imageBase64.length() > MAX_BASE64_CHARS) {
                                throw new IllegalStateException("Captured review image exceeds the supported size");
                            }
                            response.put("imageBase64", "data:image/jpeg;base64," + imageBase64);
                            response.put("captureId", captured.getName());
                            response.put("mimeType", "image/jpeg");
                            response.put("cancelled", false);
                            call.resolve(response);
                        } catch (Exception error) {
                            call.reject("Unable to preserve the captured medicine image", error);
                        } finally {
                            if (capturedBitmap != null && !capturedBitmap.isRecycled()) capturedBitmap.recycle();
                            finishCapture(captured);
                        }
                    })
                    .addOnFailureListener(error -> {
                        finishCapture(captured);
                        call.reject("ML Kit text recognition failed", error);
                    });
            } catch (Exception error) {
                finishCapture(captured);
                call.reject("Unable to read the captured medicine image", error);
            }
        });
    }

    private byte[] readFileBytes(File file) throws Exception {
        if (file == null || !file.isFile() || file.length() <= 0 || file.length() > 24L * 1024L * 1024L) {
            throw new IllegalStateException("Captured image file is missing or outside the supported size");
        }
        try (FileInputStream input = new FileInputStream(file);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            return output.toByteArray();
        }
    }

    private void finishCapture(File file) {
        if (file != null) file.delete();
        if (pendingCaptureFile == file) pendingCaptureFile = null;
        captureInProgress.set(false);
    }

    @PluginMethod
    public void recognize(PluginCall call) {
        final String encoded = call.getString("imageBase64");
        final Integer requestedRotation = call.getInt("rotation", 0);

        if (encoded == null || encoded.trim().isEmpty()) {
            call.reject("imageBase64 is required");
            return;
        }
        if (encoded.length() > MAX_BASE64_CHARS) {
            call.reject("Image is too large for OCR");
            return;
        }
        final int rotation = requestedRotation == null ? 0 : requestedRotation;
        if (rotation != 0 && rotation != 90 && rotation != 180 && rotation != 270) {
            call.reject("rotation must be 0, 90, 180, or 270");
            return;
        }

        executor.execute(() -> {
            Bitmap bitmap = null;
            try {
                String payload = encoded;
                int comma = payload.indexOf(',');
                if (payload.startsWith("data:") && comma >= 0) {
                    payload = payload.substring(comma + 1);
                }
                byte[] bytes = Base64.decode(payload, Base64.DEFAULT);
                bitmap = decodeScaledBitmap(bytes);
                if (bitmap == null) {
                    call.reject("Unable to decode the supplied image");
                    return;
                }

                InputImage inputImage = InputImage.fromBitmap(bitmap, rotation);
                final Bitmap bitmapToRelease = bitmap;
                recognizer.process(inputImage)
                    .addOnSuccessListener(result -> {
                        try {
                            call.resolve(toJsResult(result));
                        } finally {
                            bitmapToRelease.recycle();
                        }
                    })
                    .addOnFailureListener(error -> {
                        bitmapToRelease.recycle();
                        call.reject("ML Kit text recognition failed", error);
                    });
                bitmap = null; // released by the asynchronous task callbacks
            } catch (Exception error) {
                if (bitmap != null && !bitmap.isRecycled()) bitmap.recycle();
                call.reject("Unable to process image for OCR", error);
            }
        });
    }

    private Bitmap decodeScaledBitmap(byte[] bytes) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;

        int sample = 1;
        int largest = Math.max(bounds.outWidth, bounds.outHeight);
        while (largest / sample > MAX_IMAGE_EDGE) sample *= 2;

        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sample;
        options.inPreferredConfig = Bitmap.Config.ARGB_8888;
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
    }

    @NonNull
    private JSObject toJsResult(Text result) {
        JSObject output = new JSObject();
        output.put("text", result.getText());
        JSArray lines = new JSArray();
        JSArray blocks = new JSArray();
        for (Text.TextBlock block : result.getTextBlocks()) {
            JSObject blockObject = new JSObject();
            blockObject.put("text", block.getText());
            JSArray blockLines = new JSArray();
            for (Text.Line line : block.getLines()) {
                lines.put(line.getText());
                blockLines.put(line.getText());
            }
            blockObject.put("lines", blockLines);
            blocks.put(blockObject);
        }
        output.put("lines", lines);
        output.put("blocks", blocks);
        return output;
    }

    @Override
    protected void handleOnDestroy() {
        File pending = pendingCaptureFile;
        pendingCaptureFile = null;
        if (pending != null) pending.delete();
        captureInProgress.set(false);
        if (executor != null) executor.shutdown();
        if (recognizer != null) recognizer.close();
        super.handleOnDestroy();
    }
}

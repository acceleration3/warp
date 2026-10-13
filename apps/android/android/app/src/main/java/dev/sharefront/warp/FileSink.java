package dev.sharefront.warp;

import android.content.ContentResolver;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;

/**
 * A destination that accepts writes at arbitrary offsets.
 *
 * Positional writing is what makes several connections able to fill one file at
 * the same time. Two backends exist because Android storage is split:
 *
 *   - a plain File, used for the app's own external directory, which needs no
 *     permission and supports full random access;
 *   - a SAF document, opened "rw" and written through a FileChannel, used when
 *     the user picks their own folder.
 *
 * Some SAF providers (network or cloud backed) refuse "rw" or random access
 * entirely. Those are received into a private spool file instead, which does
 * support positional writes, and copied into the document by commit() once
 * the file is whole.
 */
public class FileSink implements AutoCloseable {

    private RandomAccessFile randomAccess;
    private ParcelFileDescriptor descriptor;
    private FileChannel channel;
    /** Set when writes go to a spool file that commit() must copy into this document. */
    private ContentResolver commitResolver;
    private Uri commitUri;
    private File spool;

    /** Opens a real filesystem path. */
    public FileSink(File target, long expectedSize) throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("could not create " + parent);
        }
        randomAccess = openSized(target, expectedSize);
    }

    /**
     * Exactly the expected size: preallocated so out-of-order chunks land in a
     * file of the right shape, and never longer than the file should be.
     */
    private static RandomAccessFile openSized(File target, long expectedSize) throws IOException {
        RandomAccessFile handle = new RandomAccessFile(target, "rw");
        if (handle.length() != expectedSize) handle.setLength(expectedSize);
        return handle;
    }

    /**
     * Opens a SAF document. `spoolFile` is where the bytes go instead when the
     * provider cannot do positional writes; it survives close() so a paused
     * or retried transfer picks up where it stopped.
     */
    public FileSink(ContentResolver resolver, Uri uri, long expectedSize, File spoolFile) throws IOException {
        ParcelFileDescriptor pfd = null;
        try {
            pfd = resolver.openFileDescriptor(uri, "rw");
        } catch (Exception ignored) {
            // Provider does not support read-write; spool below.
        }

        if (pfd != null) {
            FileChannel candidate = new FileOutputStream(pfd.getFileDescriptor()).getChannel();
            try {
                long size = candidate.size();
                if (size > expectedSize) {
                    candidate.truncate(expectedSize);
                } else if (expectedSize > 0 && size < expectedSize) {
                    // Grow the file so positional writes do not have to append.
                    candidate.write(ByteBuffer.wrap(new byte[]{0}), expectedSize - 1);
                }
                descriptor = pfd;
                channel = candidate;
                return;
            } catch (IOException e) {
                // Provider is backed by something that cannot seek (cloud, network).
                try {
                    candidate.close();
                    pfd.close();
                } catch (IOException ignored) {
                }
            }
        }

        File parent = spoolFile.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("could not create " + parent);
        }
        randomAccess = openSized(spoolFile, expectedSize);
        spool = spoolFile;
        commitResolver = resolver;
        commitUri = uri;
    }

    /**
     * Makes the document hold the finished bytes. A no-op for sinks that
     * wrote in place; a spooled sink copies its spool across and deletes it.
     */
    public synchronized void commit() throws IOException {
        if (spool == null) return;
        if (randomAccess != null) {
            randomAccess.close();
            randomAccess = null;
        }
        try (java.io.InputStream in = new java.io.FileInputStream(spool);
             java.io.OutputStream out = commitResolver.openOutputStream(commitUri, "wt")) {
            if (out == null) throw new IOException("cannot open " + commitUri);
            byte[] buffer = new byte[256 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
        }
        //noinspection ResultOfMethodCallIgnored
        spool.delete();
        spool = null;
    }

    /** Closes the sink and throws away anything spooled. */
    public synchronized void discard() {
        File leftover = spool;
        close();
        //noinspection ResultOfMethodCallIgnored
        if (leftover != null) leftover.delete();
    }

    public synchronized void write(byte[] buffer, int offset, int length, long position) throws IOException {
        if (randomAccess != null) {
            randomAccess.seek(position);
            randomAccess.write(buffer, offset, length);
            return;
        }
        if (channel != null) {
            ByteBuffer bytes = ByteBuffer.wrap(buffer, offset, length);
            int written = 0;
            while (bytes.hasRemaining()) {
                written += channel.write(bytes, position + written);
            }
            return;
        }
        throw new IOException("sink is closed");
    }

    public synchronized void flush() throws IOException {
        if (randomAccess != null) randomAccess.getFD().sync();
        if (channel != null) channel.force(false);
    }

    @Override
    public synchronized void close() {
        try {
            if (randomAccess != null) randomAccess.close();
        } catch (IOException ignored) {
        }
        try {
            if (channel != null) channel.close();
        } catch (IOException ignored) {
        }
        try {
            if (descriptor != null) descriptor.close();
        } catch (IOException ignored) {
        }
        randomAccess = null;
        channel = null;
        descriptor = null;
    }
}

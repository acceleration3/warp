package dev.sharefront.warp;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Path hygiene for anything that arrives from another device. */
public final class Paths {

    private Paths() {
    }

    private static final String[] WINDOWS_RESERVED = {
            "con", "prn", "aux", "nul",
            "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
            "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    };

    /**
     * Returns a safe relative path, or null when the input can never be
     * trusted. This is the only thing standing between a hostile peer and an
     * arbitrary file write, so it rejects rather than repairs.
     */
    public static String sanitizeRelative(String input) {
        if (input == null || input.isEmpty() || input.length() > 4096) return null;

        String normalized = input.replace('\\', '/').replaceAll("/+", "/");
        if (normalized.startsWith("/")) normalized = normalized.substring(1);
        if (normalized.isEmpty()) return null;

        List<String> parts = new ArrayList<>();
        for (String segment : normalized.split("/")) {
            if (segment.isEmpty() || ".".equals(segment)) continue;
            if ("..".equals(segment)) return null;
            if (hasIllegalCharacter(segment)) return null;
            if (isWindowsReserved(segment)) return null;
            // A trailing dot or space breaks on Windows and hides files elsewhere.
            char last = segment.charAt(segment.length() - 1);
            if (last == '.' || last == ' ') return null;
            parts.add(segment);
        }
        if (parts.isEmpty()) return null;
        return String.join("/", parts);
    }

    private static boolean hasIllegalCharacter(String segment) {
        for (int i = 0; i < segment.length(); i++) {
            char c = segment.charAt(i);
            if (c < 0x20) return true;
            if (c == '<' || c == '>' || c == ':' || c == '"' || c == '|' || c == '?' || c == '*') return true;
        }
        return false;
    }

    private static boolean isWindowsReserved(String segment) {
        int dot = segment.indexOf('.');
        String stem = (dot > 0 ? segment.substring(0, dot) : segment).toLowerCase(Locale.US);
        for (String reserved : WINDOWS_RESERVED) {
            if (reserved.equals(stem)) return true;
        }
        return false;
    }

    /** "photo.jpg" -> "photo (2).jpg" when the name is already taken. */
    public static String withSuffix(String name, int index) {
        int dot = name.lastIndexOf('.');
        if (dot <= 0) return name + " (" + index + ")";
        return name.substring(0, dot) + " (" + index + ")" + name.substring(dot);
    }
}

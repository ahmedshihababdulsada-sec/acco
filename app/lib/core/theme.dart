import 'package:material_ui/material_ui.dart';

/// ألوان وتصميم من نماذج المرحلة 0 (screens/*.dc.html): تركواز، رمادي مزرق، خط IBM Plex Sans Arabic.
class Palette {
  static const bg = Color(0xFFF4F5F7);
  static const surface = Colors.white;
  static const border = Color(0xFFD9DEE5);
  static const borderStrong = Color(0xFFAEB6C2);
  static const text = Color(0xFF17202A);
  static const muted = Color(0xFF55606E);
  static const primary = Color(0xFF0B6E69);
  static const primaryDark = Color(0xFF084F4B);
  static const primarySoft = Color(0xFFE3F1F0);
  static const danger = Color(0xFFB3261E);
  static const dangerSoft = Color(0xFFFCE8E6);
  static const warn = Color(0xFF9A6700);
  static const warnSoft = Color(0xFFFFF4D6);
  static const ok = Color(0xFF1B7F3B);
  static const okSoft = Color(0xFFE2F4E8);
}

ThemeData buildTheme() {
  const font = 'IBMPlexSansArabic';
  final scheme = ColorScheme.fromSeed(seedColor: Palette.primary, brightness: Brightness.light).copyWith(
    primary: Palette.primary, onPrimary: Colors.white, surface: Palette.surface, error: Palette.danger, outline: Palette.borderStrong,
  );
  OutlineInputBorder border(Color c) => OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: BorderSide(color: c));
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    fontFamily: font,
    scaffoldBackgroundColor: Palette.bg,
    appBarTheme: const AppBarTheme(backgroundColor: Palette.surface, foregroundColor: Palette.text, elevation: 0, scrolledUnderElevation: 0, centerTitle: false,
        shape: Border(bottom: BorderSide(color: Palette.border)), titleTextStyle: TextStyle(fontFamily: font, fontSize: 18, fontWeight: FontWeight.w700, color: Palette.text)),
    cardTheme: CardThemeData(color: Palette.surface, elevation: 0, margin: EdgeInsets.zero, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: const BorderSide(color: Palette.border))),
    inputDecorationTheme: InputDecorationTheme(
      filled: true, fillColor: Palette.surface, isDense: false, contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
      border: border(Palette.borderStrong), enabledBorder: border(Palette.borderStrong), focusedBorder: border(Palette.primary), errorBorder: border(Palette.danger), focusedErrorBorder: border(Palette.danger),
    ),
    filledButtonTheme: FilledButtonThemeData(style: FilledButton.styleFrom(minimumSize: const Size(0, 46), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)), textStyle: const TextStyle(fontFamily: font, fontWeight: FontWeight.w600, fontSize: 15))),
    outlinedButtonTheme: OutlinedButtonThemeData(style: OutlinedButton.styleFrom(minimumSize: const Size(0, 46), foregroundColor: Palette.text, side: const BorderSide(color: Palette.borderStrong), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)), textStyle: const TextStyle(fontFamily: font, fontWeight: FontWeight.w600, fontSize: 14))),
    textButtonTheme: TextButtonThemeData(style: TextButton.styleFrom(foregroundColor: Palette.primary, textStyle: const TextStyle(fontFamily: font, fontWeight: FontWeight.w600))),
    dividerTheme: const DividerThemeData(color: Palette.border, space: 1, thickness: 1),
    chipTheme: ChipThemeData(backgroundColor: Palette.primarySoft, side: BorderSide.none, labelStyle: const TextStyle(fontFamily: font, color: Palette.primaryDark, fontWeight: FontWeight.w600, fontSize: 13)),
    snackBarTheme: SnackBarThemeData(behavior: SnackBarBehavior.floating, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8))),
    tabBarTheme: const TabBarThemeData(labelColor: Palette.primary, unselectedLabelColor: Palette.muted, indicatorColor: Palette.primary, labelStyle: TextStyle(fontFamily: font, fontWeight: FontWeight.w700), unselectedLabelStyle: TextStyle(fontFamily: font, fontWeight: FontWeight.w500)),
  );
}

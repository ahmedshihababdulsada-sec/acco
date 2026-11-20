/// عنوان الخادم يتحدد وقت البناء: flutter run --dart-define=API_URL=https://clinic.example.com
const apiUrl = String.fromEnvironment('API_URL', defaultValue: 'http://127.0.0.1:3100');

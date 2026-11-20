import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/theme.dart';
import '../core/widgets.dart';

/// يختار صورة ويرفعها كصورة قبل/بعد مربوطة بجلسة أو بكشفية. يرجع true إذا انرفعت.
Future<bool> uploadPhoto(BuildContext context, {required String phase, int? sessionId, int? consultationId}) async {
  final api = context.read<Api>();
  final f = await FilePicker.pickFile(type: FileType.custom, allowedExtensions: ['jpg', 'jpeg', 'png', 'webp']);
  if (f == null) return false;
  final bytes = await f.readAsBytes();
  if (!context.mounted) return false;
  final area = await askText(context, 'منطقة الجسم (اختياري)', label: 'مثلاً: الوجه، الذراع', minLen: 0, yes: 'رفع');
  if (area == null || !context.mounted) return false;
  final r = await api.upload('/photos', bytes: bytes, filename: f.name, fields: {
    'phase': phase,
    if (sessionId != null) 'session_id': '$sessionId',
    if (consultationId != null) 'consultation_id': '$consultationId',
    if (area.trim().isNotEmpty) 'body_area': area.trim(),
  });
  if (!context.mounted) return true;
  toast(context, r['duplicate_of_attachment'] != null ? 'انرفعت. تنبيه: نفس الصورة انرفعت سابقاً' : 'انرفعت الصورة');
  return true;
}

/// أزرار «صورة قبل» و«صورة بعد».
class PhotoButtons extends StatelessWidget {
  const PhotoButtons({super.key, this.sessionId, this.consultationId, this.onUploaded});
  final int? sessionId;
  final int? consultationId;
  final VoidCallback? onUploaded;
  @override
  Widget build(BuildContext context) => Wrap(spacing: 8, runSpacing: 8, children: [
        for (final p in const [('before', 'صورة قبل', Icons.photo_camera_back_outlined), ('after', 'صورة بعد', Icons.photo_camera_front_outlined)])
          AsyncButton(outlined: true, icon: p.$3, onPressed: () async { if (await uploadPhoto(context, phase: p.$1, sessionId: sessionId, consultationId: consultationId)) onUploaded?.call(); }, child: Text(p.$2)),
      ]);
}

final Map<int, Future<Uint8List>> _cache = {};

/// معرض صور الزبون: قبل وبعد مرتبة بالتاريخ. المالك فقط يحذف (بسبب).
class PhotoGallery extends StatelessWidget {
  const PhotoGallery({super.key, required this.customerId, this.canDelete = false, this.controller});
  final int customerId;
  final bool canDelete;
  final LoaderController? controller;

  @override
  Widget build(BuildContext context) {
    final api = context.read<Api>();
    return Loader<List<Map<String, dynamic>>>(
      controller: controller,
      load: () async => ((await api.get('/customers/$customerId/photos'))['photos'] as List).cast<Map<String, dynamic>>(),
      builder: (context, list, reload) {
        if (list.isEmpty) return const Empty('ما أكو صور بعد');
        return Wrap(spacing: 10, runSpacing: 10, children: [for (final p in list) _Thumb(photo: p, canDelete: canDelete, onDeleted: reload)]);
      },
    );
  }
}

class _Thumb extends StatelessWidget {
  const _Thumb({required this.photo, required this.canDelete, required this.onDeleted});
  final Map<String, dynamic> photo;
  final bool canDelete;
  final Future<void> Function() onDeleted;

  @override
  Widget build(BuildContext context) {
    final api = context.read<Api>(); final id = photo['id'] as int; final before = photo['phase'] == 'before';
    final fut = _cache.putIfAbsent(id, () => api.download('/photos/$id'));
    return InkWell(
      onTap: () => showDialog<void>(context: context, builder: (d) => _Viewer(photo: photo, bytes: fut, canDelete: canDelete, onDeleted: onDeleted)),
      child: SizedBox(width: 120, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        ClipRRect(borderRadius: BorderRadius.circular(8), child: SizedBox(height: 120, child: FutureBuilder<Uint8List>(future: fut, builder: (c, s) => s.hasData ? Image.memory(s.data!, fit: BoxFit.cover) : Container(color: Palette.bg, alignment: Alignment.center, child: s.hasError ? const Icon(Icons.broken_image_outlined, color: Palette.muted) : const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)))))),
        const SizedBox(height: 4),
        Row(children: [before ? Pill.warn('قبل') : Pill.ok('بعد'), const SizedBox(width: 6), Expanded(child: Text(dmy((photo['created_at'] as String).substring(0, 10)), style: const TextStyle(fontSize: 11, color: Palette.muted)))]),
        if (photo['body_area'] != null) Text('${photo['body_area']}', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12)),
      ])),
    );
  }
}

class _Viewer extends StatelessWidget {
  const _Viewer({required this.photo, required this.bytes, required this.canDelete, required this.onDeleted});
  final Map<String, dynamic> photo;
  final Future<Uint8List> bytes;
  final bool canDelete;
  final Future<void> Function() onDeleted;

  @override
  Widget build(BuildContext context) {
    final api = context.read<Api>();
    return Dialog(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 640, maxHeight: 760), child: Column(mainAxisSize: MainAxisSize.min, children: [
      Padding(padding: const EdgeInsets.all(12), child: Row(children: [
        Expanded(child: Text('${photo['phase'] == 'before' ? 'قبل' : 'بعد'}${photo['body_area'] == null ? '' : ' · ${photo['body_area']}'}${photo['service_name'] == null ? '' : ' · ${photo['service_name']}'}', style: const TextStyle(fontWeight: FontWeight.w700))),
        IconButton(onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close)),
      ])),
      Flexible(child: FutureBuilder<Uint8List>(future: bytes, builder: (c, s) => s.hasData ? InteractiveViewer(child: Image.memory(s.data!, fit: BoxFit.contain)) : const Padding(padding: EdgeInsets.all(40), child: CircularProgressIndicator()))),
      Padding(padding: const EdgeInsets.all(12), child: Row(children: [
        Expanded(child: Text('رفعها ${(photo['uploaded_by'] as Map)['full_name']} · ${dmy((photo['created_at'] as String).substring(0, 10))}', style: const TextStyle(color: Palette.muted, fontSize: 13))),
        if (canDelete) TextButton(onPressed: () async {
          final why = await askText(context, 'حذف الصورة', label: 'سبب الحذف', yes: 'حذف');
          if (why == null) return;
          try {
            await api.post('/photos/${photo['id']}/delete', body: {'reason': why});
            _cache.remove(photo['id']);
            if (context.mounted) { Navigator.pop(context); toast(context, 'انحذفت الصورة'); }
            await onDeleted();
          } catch (e) { if (context.mounted) showError(context, e); }
        }, child: const Text('حذف', style: TextStyle(color: Palette.danger))),
      ])),
    ])));
  }
}

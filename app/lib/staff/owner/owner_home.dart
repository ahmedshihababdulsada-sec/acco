import 'package:material_ui/material_ui.dart';

import '../manager/admin_shell.dart';
import '../manager/manager_home.dart' show commonAdminSections;
import 'owner_sections.dart';

class OwnerHome extends StatelessWidget {
  const OwnerHome({super.key});
  @override
  Widget build(BuildContext context) {
    final common = commonAdminSections();
    return AdminShell(title: 'المالك', sections: [
      common.first,
      AdminSection('التقارير', Icons.insights_outlined, (_) => const ReportsSection()),
      ...common.skip(1),
      AdminSection('التقييمات', Icons.star_outline, (_) => const RatingsSection()),
      AdminSection('التعويضات', Icons.volunteer_activism_outlined, (_) => const CompensationsSection()),
      AdminSection('صور الزبائن', Icons.photo_library_outlined, (_) => const PhotosSection()),
      AdminSection('دمج الزبائن', Icons.merge_type, (_) => const CustomerMergeSection()),
    ]);
  }
}

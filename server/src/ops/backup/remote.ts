import { spawn } from 'node:child_process';
import { copyFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

export interface RemoteEntry { key: string; size: number; mtime: Date }

/**
 * مكان تخزين النسخ (بعيد عن السيرفر). الواجهة صغيرة عمداً: أي تخزين S3 (Backblaze B2، Wasabi، Hetzner...) يشتغل عبر rclone،
 * والمجلد المحلي (dir) للاختبار وللقرص الخارجي. المفاتيح (keys) مسارات نسبية بشرطة مائلة، وما تطلع برا الجذر.
 */
export interface Remote {
  put(localPath: string, key: string): Promise<void>;
  get(key: string, localPath: string): Promise<void>;
  list(prefix: string): Promise<RemoteEntry[]>;
  delete(key: string): Promise<void>;
}

export function assertKey(key: string): void {
  if (!key || key.startsWith('/') || key.includes('\\') || key.split('/').some((p) => p === '..' || p === '' || p === '.')) throw new Error(`مفتاح تخزين غير صالح: ${key}`);
}

/** مجلد على نفس الجهاز أو قرص خارجي/NAS. الكتابة ذرية (ملف مؤقت ثم rename). */
export class DirRemote implements Remote {
  private readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  private path(key: string): string { assertKey(key); const p = resolve(join(this.root, key)); if (!p.startsWith(this.root + sep)) throw new Error('مسار خارج الجذر'); return p; }
  async put(localPath: string, key: string): Promise<void> {
    const dest = this.path(key); await mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.uploading`; await copyFile(localPath, tmp); await rename(tmp, dest);
  }
  async get(key: string, localPath: string): Promise<void> { await mkdir(dirname(localPath), { recursive: true }); await copyFile(this.path(key), localPath); }
  async delete(key: string): Promise<void> { await unlink(this.path(key)).catch((e: { code?: string }) => { if (e.code !== 'ENOENT') throw e; }); }
  async list(prefix: string): Promise<RemoteEntry[]> {
    const out: RemoteEntry[] = [];
    const walk = async (dir: string): Promise<void> => {
      let names: string[]; try { names = await readdir(dir); } catch { return; }
      for (const n of names) {
        const full = join(dir, n); const st = await stat(full);
        if (st.isDirectory()) await walk(full);
        else if (!n.endsWith('.uploading')) out.push({ key: relative(this.root, full).split(sep).join('/'), size: st.size, mtime: st.mtime });
      }
    };
    const slash = prefix.lastIndexOf('/');
    await walk(slash >= 0 ? join(this.root, prefix.slice(0, slash)) : this.root);               // نمشي على مجلد البادئة بس (مو كل الأرشيف)
    return out.filter((e) => e.key.startsWith(prefix)).sort((a, b) => a.key.localeCompare(b.key));
  }
}

function runCapture(bin: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    const p = spawn(bin, args); let out = ''; let err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => rej(new Error(`تعذر تشغيل ${bin}: ${e.message}`)));
    p.on('close', (c) => (c === 0 ? res(out) : rej(new Error(`${bin} ${args[0]} فشل (${c}): ${err.trim().slice(0, 300)}`))));
  });
}

/** أي تخزين يدعمه rclone: "rclone:اسم_الريموت:الحاوية/المسار". نحتاج rclone مثبت على السيرفر (ملف تنفيذي واحد). */
export class RcloneRemote implements Remote {
  constructor(private readonly base: string, private readonly bin = process.env.RCLONE_BIN || 'rclone') {}
  private at(key: string): string { assertKey(key); return `${this.base.replace(/\/+$/, '')}/${key}`; }
  async put(localPath: string, key: string): Promise<void> { await runCapture(this.bin, ['copyto', '--checksum', localPath, this.at(key)]); }
  async get(key: string, localPath: string): Promise<void> { await mkdir(dirname(localPath), { recursive: true }); await runCapture(this.bin, ['copyto', this.at(key), localPath]); }
  async delete(key: string): Promise<void> { await runCapture(this.bin, ['deletefile', this.at(key)]).catch((e: Error) => { if (!/not found|directory not found/i.test(e.message)) throw e; }); }
  async list(prefix: string): Promise<RemoteEntry[]> {
    const slash = prefix.lastIndexOf('/'); const sub = slash >= 0 ? prefix.slice(0, slash) : '';
    const raw = await runCapture(this.bin, ['lsjson', '--recursive', '--files-only', sub ? `${this.base.replace(/\/+$/, '')}/${sub}` : this.base]).catch((e: Error) => { if (/directory not found/i.test(e.message)) return '[]'; throw e; });
    const rows = JSON.parse(raw || '[]') as { Path: string; Size: number; ModTime: string }[];
    return rows.map((r) => ({ key: sub ? `${sub}/${r.Path}` : r.Path, size: r.Size, mtime: new Date(r.ModTime) })).filter((e) => e.key.startsWith(prefix)).sort((a, b) => a.key.localeCompare(b.key));
  }
}

export function remoteFromSpec(spec: string | undefined): Remote {
  if (!spec) throw new Error('BACKUP_REMOTE غير مضبوط (dir:/path أو rclone:remote:bucket/path)');
  if (spec.startsWith('dir:')) return new DirRemote(spec.slice(4));
  if (spec.startsWith('rclone:')) return new RcloneRemote(spec.slice(7));
  throw new Error(`صيغة BACKUP_REMOTE غير معروفة: ${spec}`);
}

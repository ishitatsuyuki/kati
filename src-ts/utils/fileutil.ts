import * as fs from 'fs';
import * as path from 'path';

export class FileUtil {
  static async exists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  static async readFile(filePath: string): Promise<string> {
    return fs.promises.readFile(filePath, 'utf-8');
  }

  static async writeFile(filePath: string, content: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, {recursive: true});
    return fs.promises.writeFile(filePath, content, 'utf-8');
  }

  static async isDirectory(filePath: string): Promise<boolean> {
    try {
      const stat = await fs.promises.stat(filePath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  static async isFile(filePath: string): Promise<boolean> {
    try {
      const stat = await fs.promises.stat(filePath);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  static async listFiles(dirPath: string): Promise<string[]> {
    try {
      return await fs.promises.readdir(dirPath);
    } catch {
      return [];
    }
  }

  static resolvePath(...paths: string[]): string {
    return path.resolve(...paths);
  }

  static joinPath(...paths: string[]): string {
    return path.join(...paths);
  }

  static dirname(filePath: string): string {
    return path.dirname(filePath);
  }

  static basename(filePath: string, ext?: string): string {
    return path.basename(filePath, ext);
  }

  static extname(filePath: string): string {
    return path.extname(filePath);
  }
}

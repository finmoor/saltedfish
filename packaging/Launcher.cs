using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

internal static class Program {
    private static async Task Pump(Stream input, Stream output) {
        byte[] buffer = new byte[16384]; int length;
        while ((length = await input.ReadAsync(buffer, 0, buffer.Length)) > 0) {
            await output.WriteAsync(buffer, 0, length);
            await output.FlushAsync();
        }
    }
    // 不经过 cmd / PowerShell 解释参数，保持 MCP 的原始标准输入输出。
    private static string Quote(string value) {
        var output = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { output.Append('\\', slashes * 2 + 1); output.Append(c); }
            else { output.Append('\\', slashes); output.Append(c); }
            slashes = 0;
        }
        output.Append('\\', slashes * 2); output.Append('"'); return output.ToString();
    }
    public static int Main(string[] args) {
        try {
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);
            string root = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
            string version = File.ReadAllText(Path.Combine(root, "active-version.txt")).Trim();
            if (!Regex.IsMatch(version, @"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")) throw new Exception("安装版本标记无效。");
            string release = Path.GetFullPath(Path.Combine(root, "versions", version));
            if (!release.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new Exception("版本目录越界。");
            string node = Path.Combine(release, "runtime", "node.exe");
            string entry = Path.Combine(release, "dist", "cli.js");
            // 版本目录残缺（卸载或升级被中断、文件被清理软件删除）：同一版本的安装器会按清单补全缺失文件；没有安装包时 rollback.ps1 可退回仍完整的上一个版本。数据都不受影响。
            if (!File.Exists(node) || !File.Exists(entry)) throw new Exception("安装文件不完整（缺少 " + (File.Exists(node) ? "dist\\cli.js" : "runtime\\node.exe") + "）。请重新运行安装包里的安装器，它会补全缺失文件；没有安装包时，运行安装目录的 rollback.ps1 退回上一个版本。数据不受影响。");
            var command = new StringBuilder(Quote(entry));
            if (args.Length == 0) command.Append(" doctor");
            foreach (string arg in args) command.Append(" " + Quote(arg));
            var start = new ProcessStartInfo(node, command.ToString());
            start.UseShellExecute = false; start.CreateNoWindow = true; start.WorkingDirectory = release;
            start.RedirectStandardInput = true; start.RedirectStandardOutput = true; start.RedirectStandardError = true;
            start.EnvironmentVariables["CHROME_MCP_DATA_DIR"] = Path.Combine(root, "data");
            start.EnvironmentVariables["CHROME_MCP_LAUNCHER"] = System.Reflection.Assembly.GetExecutingAssembly().Location;
            using (var child = Process.Start(start)) {
                var output = Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput());
                var errors = Pump(child.StandardError.BaseStream, Console.OpenStandardError());
                Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream).ContinueWith(task => {
                    if (task.IsFaulted) { var ignored = task.Exception; }
                    try { child.StandardInput.Close(); } catch { }
                });
                child.WaitForExit(); Task.WaitAll(output, errors); return child.ExitCode;
            }
        } catch (Exception error) { Console.Error.WriteLine("SaltedFish: " + error.Message); return 1; }
    }
}

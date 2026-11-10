using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Reflection;

[assembly: AssemblyTitle("SaltedFish 设置")]
[assembly: AssemblyProduct("SaltedFish")]
[assembly: AssemblyDescription("打开 SaltedFish 本机管理设置")]

internal sealed class LaunchSettings { public string product; public int port; public string dataDir; public string command; public string[] args; }
internal static class DesktopProgram {
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
    // 只接受受限设置地址。注册表的 %1 不可信；注入的额外参数会在读取配置或启动进程之前被拒绝。
    public static int Main(string[] args) {
        try {
            if (args.Length != 1 || args[0].Length > 256 || !Regex.IsMatch(args[0], @"\Asaltedfish-[0-9]{4,5}://settings/(remote|setup|agents|overview)(\?[a-zA-Z0-9=&-]+)?\z")) return 2;
            string root = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
            string file = Path.Combine(root, "settings-launch.json");
            if (!File.Exists(file) || new FileInfo(file).Length > 65536) return 2;
            var settings = new JavaScriptSerializer().Deserialize<LaunchSettings>(File.ReadAllText(file, Encoding.UTF8));
            if (settings == null || settings.product != "saltedfish-desktop" || settings.port < 1024 || settings.port > 65535 || !args[0].StartsWith("saltedfish-" + settings.port + "://settings/", StringComparison.Ordinal)) return 2;
            if (String.IsNullOrEmpty(settings.command) || !Path.IsPathRooted(settings.command) || !File.Exists(settings.command) || settings.args == null || settings.args.Length > 8 || String.IsNullOrEmpty(settings.dataDir) || !Path.IsPathRooted(settings.dataDir)) return 2;
            var command = new StringBuilder();
            foreach (string arg in settings.args) { if (arg == null || arg.Length > 32768) return 2; command.Append(Quote(arg)).Append(' '); }
            command.Append("desktop-open ").Append(Quote(args[0]));
            var start = new ProcessStartInfo(settings.command, command.ToString());
            start.UseShellExecute = false; start.CreateNoWindow = true; start.WorkingDirectory = root;
            start.EnvironmentVariables["CHROME_MCP_DATA_DIR"] = Path.GetFullPath(settings.dataDir);
            start.RedirectStandardOutput = true; start.RedirectStandardError = true;
            using (var child = Process.Start(start)) {
                var output = child.StandardOutput.ReadToEndAsync(); var errors = child.StandardError.ReadToEndAsync();
                if (!child.WaitForExit(30000)) { try { child.Kill(); } catch { } return 1; }
                System.Threading.Tasks.Task.WaitAll(output, errors);
                // 不把一次码或错误中的本机路径写入终端/日志；设置页保留其他打开方式。
                return child.ExitCode;
            }
        } catch { return 1; }
    }
}

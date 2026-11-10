using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

[assembly: AssemblyTitle("SaltedFish 浏览器设置入口")]
[assembly: AssemblyProduct("SaltedFish")]
[assembly: AssemblyDescription("为已登记扩展打开 SaltedFish 本机设置")]

internal sealed class NativeLaunchSettings {
    public string product; public int port; public string dataDir; public string command; public string[] args; public string[] allowedOrigins;
}
internal sealed class NativeHostManifest { public string name; public string type; public string path; public string[] allowed_origins; }

// 进程超时、Chrome 关闭管道或 wrapper 退出时，连同固定 launcher 启动的 Node 一并结束。
internal sealed class ChildJob : IDisposable {
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits {
        public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits {
        public BasicLimits BasicLimitInformation; public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll")] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    private IntPtr handle;
    public ChildJob() {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) throw new InvalidOperationException();
        var limits = new ExtendedLimits(); limits.BasicLimitInformation.LimitFlags = 0x2000;
        int size = Marshal.SizeOf(typeof(ExtendedLimits)); IntPtr memory = Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(limits, memory, false);
            if (!SetInformationJobObject(handle, 9, memory, (uint)size)) { Dispose(); throw new InvalidOperationException(); }
        } finally { Marshal.FreeHGlobal(memory); }
    }
    public void Add(Process process) { if (!AssignProcessToJobObject(handle, process.Handle)) throw new InvalidOperationException(); }
    public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
}

internal static class NativeSettingsProgram {
    private const int MessageLimit = 4096;
    private static bool Origin(string value) { return value != null && Regex.IsMatch(value, @"\Achrome-extension://[a-p]{32}/\z"); }
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
    private static T ReadConfig<T>(string file) {
        if (!File.Exists(file) || new FileInfo(file).Length < 1 || new FileInfo(file).Length > 65536) throw new InvalidOperationException();
        using (var stream = File.OpenRead(file)) {
            byte[] bytes = new byte[65537]; int length = 0, count;
            while (length < bytes.Length && (count = stream.Read(bytes, length, bytes.Length - length)) > 0) length += count;
            if (length > 65536) throw new InvalidOperationException();
            return new JavaScriptSerializer().Deserialize<T>(new UTF8Encoding(false, true).GetString(bytes, 0, length));
        }
    }
    private static void ReadExact(Stream input, byte[] buffer, int offset, int count) {
        while (count > 0) { int read = input.Read(buffer, offset, count); if (read == 0) throw new EndOfStreamException(); offset += read; count -= read; }
    }
    private static byte[] ReadFrame(Stream input, bool requireEnd, int limit = MessageLimit) {
        byte[] header = new byte[4]; ReadExact(input, header, 0, header.Length);
        uint size = (uint)header[0] | ((uint)header[1] << 8) | ((uint)header[2] << 16) | ((uint)header[3] << 24);
        if (size < 1 || size > limit) throw new InvalidOperationException();
        byte[] frame = new byte[size + 4]; Array.Copy(header, frame, 4); ReadExact(input, frame, 4, (int)size);
        if (requireEnd && input.ReadByte() != -1) throw new InvalidOperationException();
        return frame;
    }
    private static void WriteFrame(byte[] frame) {
        var output = Console.OpenStandardOutput(); output.Write(frame, 0, frame.Length); output.Flush();
    }
    private static int Fail(string code, string message) {
        try {
            byte[] body = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(new { ok = false, error = new { code, message } }));
            byte[] frame = new byte[body.Length + 4];
            frame[0] = (byte)body.Length; frame[1] = (byte)(body.Length >> 8); frame[2] = (byte)(body.Length >> 16); frame[3] = (byte)(body.Length >> 24);
            Array.Copy(body, 0, frame, 4, body.Length); WriteFrame(frame);
        } catch { }
        return 1;
    }
    public static int Main(string[] args) {
        try {
            // Chrome 额外提供窗口句柄；它仅作语法检查，不参与进程参数、授权或页面选择。
            if (args.Length < 1 || args.Length > 2 || !Origin(args[0]) || args.Length == 2 && !Regex.IsMatch(args[1], @"\A--parent-window=[0-9]{1,20}\z")) return Fail("CALLER_NOT_ALLOWED", "此扩展尚未获准打开设置，请修复 SaltedFish 安装。");
            string root = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
            var settings = ReadConfig<NativeLaunchSettings>(Path.Combine(root, "native-launch.json"));
            if (settings == null || settings.product != "saltedfish-native-settings" || settings.port < 1024 || settings.port > 65535 || settings.allowedOrigins == null || settings.allowedOrigins.Length < 1 || settings.allowedOrigins.Length > 64) throw new InvalidOperationException();
            var origins = new HashSet<string>(StringComparer.Ordinal);
            foreach (string origin in settings.allowedOrigins) { if (!Origin(origin) || !origins.Add(origin)) throw new InvalidOperationException(); }
            if (!origins.Contains(args[0])) return Fail("CALLER_NOT_ALLOWED", "此扩展尚未获准打开设置，请修复 SaltedFish 安装。");
            if (String.IsNullOrEmpty(settings.dataDir) || !Path.IsPathRooted(settings.dataDir) || !String.Equals(Path.GetFullPath(Path.Combine(settings.dataDir, "native-settings")), root.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException();
            var manifest = ReadConfig<NativeHostManifest>(Path.Combine(root, "host.json"));
            if (manifest == null || manifest.name != "com.saltedfish.settings.p" + settings.port || manifest.type != "stdio" || manifest.allowed_origins == null || !origins.SetEquals(manifest.allowed_origins) || !String.Equals(Path.GetFullPath(manifest.path), Assembly.GetExecutingAssembly().Location, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException();
            if (String.IsNullOrEmpty(settings.command) || !Path.IsPathRooted(settings.command) || !File.Exists(settings.command) || settings.args == null || settings.args.Length > 8 || !File.Exists(Path.Combine(settings.dataDir, "config.json"))) throw new InvalidOperationException();
            var command = new StringBuilder();
            foreach (string arg in settings.args) { if (arg == null || arg.Length > 32768 || arg.IndexOf('\0') >= 0) throw new InvalidOperationException(); command.Append(Quote(arg)).Append(' '); }
            command.Append("native-settings ").Append(Quote(args[0]));
            var request = Task.Run(() => ReadFrame(Console.OpenStandardInput(), false));
            if (!request.Wait(5000)) return Fail("REQUEST_TIMEOUT", "打开设置超时，请重试。");
            var start = new ProcessStartInfo(settings.command, command.ToString());
            start.UseShellExecute = false; start.CreateNoWindow = true; start.WorkingDirectory = root;
            start.EnvironmentVariables["CHROME_MCP_DATA_DIR"] = Path.GetFullPath(settings.dataDir);
            start.RedirectStandardInput = true; start.RedirectStandardOutput = true; start.RedirectStandardError = true;
            using (var job = new ChildJob()) using (var child = Process.Start(start)) {
                try {
                    job.Add(child);
                    // 原始字节转发，禁止 TextWriter/编码器改变 4 字节帧头。stderr 仅排空，不回显凭据或路径。
                    var errors = Task.Run(() => { try { byte[] discarded = new byte[4096]; while (child.StandardError.BaseStream.Read(discarded, 0, discarded.Length) > 0) { } } catch { } });
                    var response = Task.Run(() => ReadFrame(child.StandardOutput.BaseStream, true, 512 * 1024));
                    // 写满管道也必须受同一超时控制；入口损坏、不读 stdin 时主线程不能卡死。
                    var input = Task.Run(() => { try { child.StandardInput.BaseStream.Write(request.Result, 0, request.Result.Length); child.StandardInput.BaseStream.Flush(); child.StandardInput.Close(); } catch { } });
                    if (!response.Wait(12000) || !child.WaitForExit(1000) || child.ExitCode != 0) return Fail("SETTINGS_UNAVAILABLE", "暂时无法打开设置，请确认 SaltedFish 本机服务正在运行。");
                    // Node 只输出有界 JSON；错误退出或额外 stdout 字节不会被当成 Chrome 消息。
                    var value = new JavaScriptSerializer().DeserializeObject(new UTF8Encoding(false, true).GetString(response.Result, 4, response.Result.Length - 4)) as Dictionary<string, object>;
                    if (value == null || !value.ContainsKey("ok") || !(value["ok"] is bool)) throw new InvalidOperationException();
                    WriteFrame(response.Result); return 0;
                } finally { try { if (!child.HasExited) child.Kill(); } catch { } }
            }
        } catch { return Fail("SETTINGS_UNAVAILABLE", "暂时无法打开设置，请确认 SaltedFish 本机服务正在运行。"); }
    }
}

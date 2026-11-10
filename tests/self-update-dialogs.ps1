param([string]$Folder,[string]$Log,[int]$BrowserProcess,[int]$Seconds=30)
# Answers the native folder picker and Chrome's edit-permission prompts for tests/self-update.integration.ts.
# Only touches windows of the Chrome the test started: other Chromium apps share the window class and may have their own Allow buttons.
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class DialogWindow{[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,string l);[DllImport("user32.dll")]public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);}'
$Element=[System.Windows.Automation.AutomationElement]
$Control=[System.Windows.Automation.ControlType]
function Note($text){ Add-Content -LiteralPath $Log -Value $text -Encoding UTF8 }
function Has($property,$value){ New-Object System.Windows.Automation.PropertyCondition($property,$value) }
$WM_SETTEXT=0x000C;$BM_CLICK=0x00F5
$root=$Element::RootElement
$shown=@{}
$picked=$false
$deadline=(Get-Date).AddSeconds($Seconds)
Note 'start'
while((Get-Date) -lt $deadline){
  try{
    # The folder picker runs in a utility child process, so match the whole process tree.
    $family=@{$BrowserProcess=$true};$processes=@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'");$grew=$true
    while($grew){$grew=$false;foreach($process in $processes){if($family.ContainsKey([int]$process.ParentProcessId) -and -not $family.ContainsKey([int]$process.ProcessId)){$family[[int]$process.ProcessId]=$true;$grew=$true}}}
    foreach($window in $root.FindAll('Children',[System.Windows.Automation.Condition]::TrueCondition)){
      if(-not $family.ContainsKey([int]$window.Current.ProcessId)){continue}
      $class=$window.Current.ClassName
      if($class -ne '#32770' -and $class -ne 'Chrome_WidgetWin_1'){continue}
      if($class -eq '#32770'){$dialogs=@($window)}else{$dialogs=@($window.FindAll('Children',(Has $Element::ClassNameProperty '#32770')))}
      foreach($dialog in $dialogs){
        if($picked){continue}
        $path=$dialog.FindFirst('Descendants',(Has $Element::AutomationIdProperty '1152'))
        $accept=$null;foreach($button in $dialog.FindAll('Descendants',(Has $Element::ClassNameProperty 'Button'))){if($button.Current.AutomationId -eq '1'){$accept=$button}}
        if($path -and $accept){
          Note 'folder picker'
          [void][DialogWindow]::SendMessage([IntPtr]$path.Current.NativeWindowHandle,$WM_SETTEXT,[IntPtr]::Zero,$Folder)
          Start-Sleep -Milliseconds 300
          [void][DialogWindow]::SendMessage([IntPtr]$accept.Current.NativeWindowHandle,$BM_CLICK,[IntPtr]::Zero,[IntPtr]::Zero)
          $picked=$true
        }
      }
      if($class -eq 'Chrome_WidgetWin_1'){
        foreach($button in $window.FindAll('Descendants',(Has $Element::ControlTypeProperty $Control::Button))){
          $name=$button.Current.Name
          if($name -notmatch '^(Allow|Allow this time)$'){continue}
          # Chrome ignores clicks on a permission prompt for about half a second after it appears, so wait first and press again if it stays.
          $key=$name+$button.Current.BoundingRectangle.ToString()
          if(-not $shown[$key]){$shown[$key]=(Get-Date).AddMilliseconds(800)}
          if((Get-Date) -lt $shown[$key]){continue}
          $shown[$key]=(Get-Date).AddMilliseconds(1500)
          Note ('press '+$name)
          $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        }
      }
    }
  }catch{ Note ('error '+$_.Exception.Message) }
  Start-Sleep -Milliseconds 300
}
Note 'end'

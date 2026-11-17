; Inno Setup script. Workflow supplies AppVersion, SourceDir and OutputDir.
#ifndef AppVersion
  #error AppVersion must be supplied
#endif
#ifndef SourceDir
  #error SourceDir must be supplied
#endif
#ifndef OutputDir
  #error OutputDir must be supplied
#endif

[Setup]
AppId={{A7BD01CA-CC31-4948-A3E4-563A7EEC1BE0}
AppName=НейроЯдро
AppVersion={#AppVersion}
AppPublisher=NeuroYadro
DefaultDirName={autopf}\NeuroYadro
DefaultGroupName=НейроЯдро
DisableProgramGroupPage=yes
OutputDir={#OutputDir}
OutputBaseFilename=NeuroYadro-windows-x64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName=НейроЯдро

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\НейроЯдро"; Filename: "{app}\NeuroYadro.exe"
Name: "{autodesktop}\НейроЯдро"; Filename: "{app}\NeuroYadro.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Создать ярлык на рабочем столе"; GroupDescription: "Дополнительные значки:"

[Run]
Filename: "{app}\NeuroYadro.exe"; Description: "Запустить НейроЯдро"; Flags: nowait postinstall skipifsilent

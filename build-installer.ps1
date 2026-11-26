param(
  [Parameter(Mandatory)][string]$Compiler,
  [switch]$ValidationBuild
)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$release=Join-Path $root 'Dsh-release'
$work=Join-Path $root '.dsh-build/installer'
[void](New-Item -Path $work -ItemType Directory -Force)
$zip=Join-Path $release 'Dsh文献翻译-Windows-x64-便携版.zip'
$payloadRoot=Join-Path $work ([guid]::NewGuid().ToString('n'))
try {
  Expand-Archive -LiteralPath $zip -DestinationPath $payloadRoot
  $payload=Join-Path $payloadRoot 'Dsh文献翻译'
  $version=(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Raw | ConvertFrom-Json).version
  $label=if($ValidationBuild){'Dsh文献翻译（验收）'}else{'Dsh文献翻译'}
  $keySuffix=if($ValidationBuild){'DshLiteratureTranslation.Validation'}else{'DshLiteratureTranslation'}
  $output=if($ValidationBuild){Join-Path $work 'validation-setup.exe'}else{Join-Path $release 'Dsh文献翻译-Windows-x64-安装程序.exe'}
  $manifest=Join-Path $payloadRoot 'uninstall-files.nsh'
  function Escape-Nsis([string]$value) {
    $value.Replace('$','$$').Replace('"','$\"')
  }
  $lines=foreach($file in Get-ChildItem -LiteralPath $payload -Recurse -File -Force){
    $relative=Escape-Nsis $file.FullName.Substring($payload.Length+1)
    '  Delete "$INSTDIR\'+$relative+'"'
  }
  $lines+=foreach($dir in (Get-ChildItem -LiteralPath $payload -Recurse -Directory -Force | Sort-Object {$_.FullName.Length} -Descending)){
    $relative=Escape-Nsis $dir.FullName.Substring($payload.Length+1)
    '  RMDir "$INSTDIR\'+$relative+'"'
  }
  $lines | Set-Content -LiteralPath $manifest -Encoding utf8BOM
  & $Compiler /V2 "/DDISPLAY_NAME=$label" "/DSETUP_FILE=$output" "/DPAYLOAD=$payload" "/DPRODUCT_VERSION=$version" "/DUNINSTALL_KEY=Software\Microsoft\Windows\CurrentVersion\Uninstall\$keySuffix" "/DUNINSTALL_FILES=$manifest" (Join-Path $PSScriptRoot 'installer.nsi')
  if($LASTEXITCODE){throw "NSIS build failed: $LASTEXITCODE"}
  Get-Item -LiteralPath $output
} finally {
  if(Test-Path -LiteralPath $payloadRoot){
    $resolved=(Resolve-Path -LiteralPath $payloadRoot).Path
    if($resolved -ne $payloadRoot -or (Split-Path -Parent $resolved) -ne $work){throw 'Unexpected build workspace'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}

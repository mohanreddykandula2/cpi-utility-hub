service ArtifactService @(path: '/api/artifact') {
  function health() returns String;

  type ScriptInfo {
    originalPath : String;
    originalName : String;
    newName      : String;
    stepNames    : many String;
    used        : Boolean;
    usageStatus : String;
  }

  type AnalyzeResult {
    fileName : String;
    scripts  : many ScriptInfo;
  }

  type RenameItem {
    originalPath : String;
    originalName : String;
    newName      : String;
  }

  type GenerateResult {
    fileName  : String;
    zipBase64 : LargeString;
  }

  type DeployResult {
    success : Boolean;
    message : String;
  }

  action analyzeArtifact(fileName: String, zipBase64: LargeString) returns AnalyzeResult;
  action generateArtifact(fileName: String, zipBase64: LargeString, renames: many RenameItem) returns GenerateResult;
  action downloadFromCpi(iflowId: String) returns GenerateResult;
  action deployToCpi(iflowId: String, zipBase64: LargeString, comment: String) returns DeployResult;
}
sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox",
  "sap/ui/core/ValueState"
], function (Controller, JSONModel, MessageToast, MessageBox, ValueState) {
  "use strict";

  return Controller.extend("com.cpi.utility.cpiutilityui.controller.Main", {
    onInit: function () {
      this.getView().setModel(new JSONModel({
        iflowId: "",
        canDownloadFromCpi: false,
        isBusy: false,
        fileName: "",
        zipBase64: "",
        hasFile: false,
        canGenerate: false,
        canDeployToCpi: false,
        scripts: []
      }));
    },

    onFileSelected: function (event) {
      const file = event.getParameter("files") && event.getParameter("files")[0];

      if (!file) {
        return;
      }

      if (!file.name.toLowerCase().endsWith(".zip")) {
        MessageBox.warning("Please select a SAP CPI ZIP artifact.");
        return;
      }

      const reader = new FileReader();

      reader.onload = () => {
        const base64 = reader.result.split(",")[1];
        const model = this.getView().getModel();

        model.setProperty("/fileName", file.name);
        model.setProperty("/zipBase64", base64);
        model.setProperty("/hasFile", true);
        model.setProperty("/canGenerate", false);
        model.setProperty("/scripts", []);

        MessageToast.show("Artifact loaded. Click Analyze Artifact.");
      };

      reader.readAsDataURL(file);
    },
    onIflowIdChanged: function (event) {
      const iflowId = String(event.getParameter("value") || "").trim();
      const model = this.getView().getModel();

      model.setProperty("/iflowId", iflowId);
      model.setProperty("/canDownloadFromCpi", Boolean(iflowId));
    },

    onDownloadFromCpi: async function () {
      const model = this.getView().getModel();
      const iflowId = String(model.getProperty("/iflowId") || "").trim();

      if (!iflowId) {
        MessageBox.warning("Enter an iFlow ID before downloading from CPI.");
        return;
      }

      try {
        model.setProperty("/isBusy", true);

        const downloadResult = await this._postAction("downloadFromCpi", {
          iflowId
        });

        model.setProperty("/fileName", downloadResult.fileName);
        model.setProperty("/zipBase64", downloadResult.zipBase64);
        model.setProperty("/hasFile", true);
        model.setProperty("/canGenerate", false);
        model.setProperty("/scripts", []);

        const analyzeResult = await this._postAction("analyzeArtifact", {
          fileName: downloadResult.fileName,
          zipBase64: downloadResult.zipBase64
        });

        const scripts = (analyzeResult.scripts || []).map(script => ({
          ...script,
          valueState: ValueState.None,
          valueStateText: ""
        }));

        model.setProperty("/scripts", scripts);
        this._refreshGenerateState();

        MessageToast.show(`Artifact downloaded from CPI. Found ${scripts.length} script(s).`);
      } catch (error) {
        MessageBox.error(error.message);
      } finally {
        model.setProperty("/isBusy", false);
      }
    },
    onAnalyzeArtifact: async function () {
      const model = this.getView().getModel();

      try {
        const result = await this._postAction("analyzeArtifact", {
          fileName: model.getProperty("/fileName"),
          zipBase64: model.getProperty("/zipBase64")
        });

        const scripts = (result.scripts || []).map(script => ({
          ...script,
          valueState: ValueState.None,
          valueStateText: ""
        }));

        model.setProperty("/scripts", scripts);
        this._refreshGenerateState();

        MessageToast.show(`Found ${scripts.length} script(s).`);
      } catch (error) {
        MessageBox.error(error.message);
      }
    },

    onGenerateArtifact: async function () {
      const model = this.getView().getModel();

      if (!this._refreshGenerateState()) {
        MessageBox.warning("Fix script name warnings before generating the ZIP.");
        return;
      }

      const scripts = model.getProperty("/scripts") || [];
      const renames = scripts
        .map(script => ({
          originalPath: script.originalPath,
          originalName: script.originalName,
          newName: String(script.newName || "").trim()
        }))
        .filter(script => script.newName && script.newName !== script.originalName);

      if (!renames.length) {
        MessageBox.warning("Rename at least one script before generating the ZIP.");
        return;
      }

      try {
        const result = await this._postAction("generateArtifact", {
          fileName: model.getProperty("/fileName"),
          zipBase64: model.getProperty("/zipBase64"),
          renames
        });

        this._downloadBase64Zip(result.fileName, result.zipBase64);
        MessageToast.show("Modified ZIP generated.");
      } catch (error) {
        MessageBox.error(error.message);
      }
    },
    onDeployToCpi: async function () {
      const model = this.getView().getModel();
      const iflowId = String(model.getProperty("/iflowId") || "").trim();

      if (!iflowId) {
        MessageBox.warning("Enter an iFlow ID before deploying to CPI.");
        return;
      }

      if (!this._refreshGenerateState()) {
        MessageBox.warning("Fix script name warnings before deploying.");
        return;
      }

      const scripts = model.getProperty("/scripts") || [];
      const renames = scripts
        .map(script => ({
          originalPath: script.originalPath,
          originalName: script.originalName,
          newName: String(script.newName || "").trim()
        }))
        .filter(script => script.newName && script.newName !== script.originalName);

      if (!renames.length) {
        MessageBox.warning("Rename at least one script before deploying.");
        return;
      }

      try {
        model.setProperty("/isBusy", true);

        const generated = await this._postAction("generateArtifact", {
          fileName: model.getProperty("/fileName"),
          zipBase64: model.getProperty("/zipBase64"),
          renames
        });

        const deployResult = await this._postAction("deployToCpi", {
          iflowId,
          zipBase64: generated.zipBase64
        });

        MessageBox.success(deployResult.message || "Artifact deployed to SAP CPI.");
      } catch (error) {
        MessageBox.error(error.message);
      } finally {
        model.setProperty("/isBusy", false);
      }
    },

    onScriptNameChanged: function () {
      this._refreshGenerateState();
    },

    formatStepNames: function (stepNames) {
      return Array.isArray(stepNames) && stepNames.length ? stepNames.join(", ") : "No step reference detected";
    },

    _refreshGenerateState: function () {
      const model = this.getView().getModel();
      const scripts = model.getProperty("/scripts") || [];
      const seenNames = new Map();
      let hasRename = false;
      let hasError = false;

      scripts.forEach(script => {
        const newName = String(script.newName || "").trim().toLowerCase();
        if (!newName) {
          return;
        }

        seenNames.set(newName, (seenNames.get(newName) || 0) + 1);
      });

      scripts.forEach(script => {
        const warnings = this._getScriptNameWarnings(script, seenNames);
        const nextName = String(script.newName || "").trim();

        script.valueState = warnings.length ? ValueState.Error : ValueState.None;
        script.valueStateText = warnings.join(" ");
        hasError = hasError || warnings.length > 0;
        hasRename = hasRename || Boolean(nextName && nextName !== script.originalName);
      });

      model.setProperty("/scripts", scripts);
      model.setProperty("/canGenerate", hasRename && !hasError);
      model.setProperty("/canDeployToCpi", hasRename && !hasError && Boolean(String(model.getProperty("/iflowId") || "").trim()));

      return !hasError;
    },

    _getScriptNameWarnings: function (script, seenNames) {
      const warnings = [];
      const newName = String(script.newName || "").trim();

      if (!newName) {
        warnings.push("Script name cannot be empty.");
        return warnings;
      }

      if (/[\\/]/.test(newName)) {
        warnings.push("Use a file name only, not a folder path.");
      }

      if (!/\.(groovy|js)$/i.test(newName)) {
        warnings.push("Use a .groovy or .js extension.");
      }

      const baseName = newName.replace(/\.(groovy|js)$/i, "");
      if (!baseName.replace(/\./g, "").trim()) {
        warnings.push("Add a script name before the extension.");
      }

      if ((seenNames.get(newName.toLowerCase()) || 0) > 1) {
        warnings.push("This new script name is duplicated.");
      }

      return warnings;
    },

    _postAction: async function (actionName, payload) {
      const response = await fetch(`/api/artifact/${actionName}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error && data.error.message ? data.error.message : "Request failed.");
      }

      return data;
    },

    _downloadBase64Zip: function (fileName, zipBase64) {
      const binary = atob(zipBase64);
      const bytes = new Uint8Array(binary.length);

      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      const blob = new Blob([bytes], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = url;
      link.download = fileName || "modified-artifact.zip";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }
  });
});
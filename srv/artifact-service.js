const cds = require('@sap/cds');
const JSZip = require('jszip');
const { DOMParser } = require("@xmldom/xmldom");
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

const CPI_DESTINATION = 'CPI_DESIGNTIME_API';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function odataString(value) {
  return String(value || '').replace(/'/g, "''");
}

function getCpiErrorMessage(error, fallback) {
  const status = error?.response?.status;
  const statusText = error?.response?.statusText;
  const data = error?.response?.data;

  if (status === 400) {
    return 'SAP CPI Error: Bad Request. Check whether the iFlow is locked/open in SAP CPI, then verify the iFlow ID and generated ZIP.';
  }

  if (status === 401) {
    return '401 Unauthorized: Destination credentials are invalid or token is expired.';
  }

  if (status === 403) {
    return '403 Forbidden: Destination user may not have permission to modify CPI artifacts, or CSRF validation failed.';
  }

  if (typeof data === 'string' && data.trim()) {
    return data;
  }

  return status ? `SAP CPI Error: ${statusText || status}` : fallback;
}

function validateRenames(renames) {
  if (!Array.isArray(renames) || renames.length === 0) {
    return 'At least one rename is required.';
  }

  const seen = new Set();

  for (const item of renames) {
    const newName = String(item.newName || '').trim();

    if (!item.originalPath || !item.originalName || !newName) {
      return 'Each rename must include originalPath, originalName, and newName.';
    }

    if (/[\\/]/.test(newName)) {
      return 'New script name must be a file name only, not a folder path.';
    }

    if (!/\.(groovy|js)$/i.test(newName)) {
      return 'New script name must end with .groovy or .js.';
    }

    const baseName = newName.replace(/\.(groovy|js)$/i, '');
    if (!baseName.replace(/\./g, '').trim()) {
      return 'New script name must include a name before the extension.';
    }

    const normalized = newName.toLowerCase();
    if (seen.has(normalized)) {
      return 'Duplicate new script names are not allowed.';
    }

    seen.add(normalized);
  }

  return '';
}
async function extractScriptStepMap(zip) {
  const scriptToStepMap = {};

  const iflwFiles = Object.values(zip.files).filter(file =>
    !file.dir &&
    file.name.startsWith("src/main/resources/scenarioflows/integrationflow/") &&
    file.name.endsWith(".iflw")
  );

  for (const iflwFile of iflwFiles) {
    const xmlContent = await iflwFile.async("string");
    const xmlDoc = new DOMParser().parseFromString(xmlContent, "application/xml");
    const allElements = xmlDoc.getElementsByTagName("*");

    for (let i = 0; i < allElements.length; i++) {
      const element = allElements[i];
      const tagName = String(element.localName || element.tagName || "").toLowerCase();

      if (tagName !== "value") {
        continue;
      }

      const scriptPath = String(element.textContent || "").trim();

      if (!/\.(groovy|js)$/i.test(scriptPath)) {
        continue;
      }

      const scriptFile = scriptPath.split("/").pop();
      let current = element.parentNode;
      let stepName = "";

      while (current && current.nodeType === 1) {
        const currentTag = String(current.localName || current.tagName || "").toLowerCase();

        if (
          currentTag.includes("process") ||
          currentTag.includes("collaboration") ||
          currentTag.includes("participant")
        ) {
          break;
        }

        if (current.getAttribute && current.getAttribute("name")) {
          stepName = current.getAttribute("name");
          break;
        }

        current = current.parentNode;
      }

      if (scriptFile && stepName) {
        scriptToStepMap[scriptFile] = scriptToStepMap[scriptFile] || [];

        if (!scriptToStepMap[scriptFile].includes(stepName)) {
          scriptToStepMap[scriptFile].push(stepName);
        }
      }
    }
  }

  return scriptToStepMap;
}
async function analyzeZip(fileName, zipBase64) {
  const zipBuffer = Buffer.from(zipBase64, 'base64');
  const loadedZip = await JSZip.loadAsync(zipBuffer);
  const scriptToStepMap = await extractScriptStepMap(loadedZip);

  const iflwFiles = Object.values(loadedZip.files).filter(
    file =>
      !file.dir &&
      file.name.startsWith('src/main/resources/scenarioflows/integrationflow/') &&
      file.name.endsWith('.iflw')
  );

  for (const iflw of iflwFiles) {
    const xmlContent = await iflw.async('string');

    const scriptMatches = [...xmlContent.matchAll(/<[^>]*value[^>]*>([^<]+\.(?:groovy|js))<\/[^>]*value>/gi)];

    for (const match of scriptMatches) {
      const scriptPath = match[1].trim();
      const scriptFile = scriptPath.split('/').pop();

      if (!scriptFile) continue;

      if (!scriptToStepMap[scriptFile]) {
        scriptToStepMap[scriptFile] = [];
      }
    }

    const stepBlocks = [...xmlContent.matchAll(/<[^>]*(?:name)="([^"]+)"[^>]*>[\s\S]*?<\/[^>]+>/g)];

    for (const block of stepBlocks) {
      const stepName = block[1];
      const blockText = block[0];

      Object.keys(scriptToStepMap).forEach(scriptFile => {
        if (blockText.includes(scriptFile) && !scriptToStepMap[scriptFile].includes(stepName)) {
          scriptToStepMap[scriptFile].push(stepName);
        }
      });
    }
  }

  const scripts = [];

  loadedZip.forEach((relativePath, zipEntry) => {
    if (!zipEntry.dir && relativePath.startsWith('src/main/resources/script/')) {
      const originalName = relativePath.split('/').pop();

      const stepNames = scriptToStepMap[originalName] || [];

      scripts.push({
        originalPath: relativePath,
        originalName,
        newName: originalName,
        stepNames,
        used: stepNames.length > 0,
        usageStatus: stepNames.length > 0 ? "Used" : "Unused"
      });
    }
  });

  return {
    fileName,
    scripts,
  };
}

async function generateZip(fileName, zipBase64, renames) {
  const validationError = validateRenames(renames);
  if (validationError) {
    const error = new Error(validationError);
    error.statusCode = 400;
    throw error;
  }

  const zipBuffer = Buffer.from(zipBase64, 'base64');
  const loadedZip = await JSZip.loadAsync(zipBuffer);
  const newZip = new JSZip();
  const renameList = renames.map(item => ({
    ...item,
    newName: String(item.newName).trim(),
  }));

  const allPaths = Object.keys(loadedZip.files);

  for (const path of allPaths) {
    const fileEntry = loadedZip.files[path];
    if (fileEntry.dir) continue;

    const matchingScript = renameList.find(item => item.originalPath === path);

    if (matchingScript) {
      const newPath = path.replace(matchingScript.originalName, matchingScript.newName);
      const content = await fileEntry.async('uint8array');
      newZip.file(newPath, content);
      continue;
    }

    if (path.startsWith('src/main/resources/scenarioflows/integrationflow/') && path.endsWith('.iflw')) {
      let xmlContent = await fileEntry.async('string');

      renameList.forEach(renameInfo => {
        const regex = new RegExp(`\\b${escapeRegExp(renameInfo.originalName)}\\b`, 'g');
        xmlContent = xmlContent.replace(regex, renameInfo.newName);
      });

      newZip.file(path, xmlContent);
      continue;
    }

    if (path.endsWith('.prop') || path.endsWith('.xml') || path.endsWith('.mf')) {
      let textContent = await fileEntry.async('string');

      renameList.forEach(renameInfo => {
        const regex = new RegExp(`\\b${escapeRegExp(renameInfo.originalName)}\\b`, 'g');
        textContent = textContent.replace(regex, renameInfo.newName);
      });

      newZip.file(path, textContent);
      continue;
    }

    const content = await fileEntry.async('uint8array');
    newZip.file(path, content);
  }

  const generatedBase64 = await newZip.generateAsync({
    type: 'base64',
    compression: 'DEFLATE',
  });

  return {
    fileName: fileName.replace(/\.zip$/i, '_modified.zip'),
    zipBase64: generatedBase64,
  };
}

async function downloadFromCpi(iflowId) {
  const endpoint = `/IntegrationDesigntimeArtifacts(Id='${odataString(iflowId)}',Version='active')/$value`;

  const response = await executeHttpRequest(
    { destinationName: CPI_DESTINATION },
    {
      method: 'GET',
      url: endpoint,
      responseType: 'arraybuffer',
    }
  );

  return {
    fileName: `${iflowId}.zip`,
    zipBase64: Buffer.from(response.data).toString('base64'),
  };
}

async function deployToCpi(iflowId, zipBase64, comment) {
  const endpoint = `/IntegrationDesigntimeArtifacts(Id='${odataString(iflowId)}',Version='active')`;

  let csrfToken = '';
  let cookies = '';

  try {
    const csrfResponse = await executeHttpRequest(
      { destinationName: CPI_DESTINATION },
      {
        method: 'GET',
        url: '/$metadata',
        headers: {
          'X-CSRF-Token': 'Fetch',
        },
      }
    );

    csrfToken = csrfResponse.headers['x-csrf-token'] || '';
    const setCookie = csrfResponse.headers['set-cookie'];

    if (Array.isArray(setCookie)) {
      cookies = setCookie.map(cookie => cookie.split(';')[0]).join('; ');
    }
  } catch (error) {
    csrfToken = error?.response?.headers?.['x-csrf-token'] || '';
    const setCookie = error?.response?.headers?.['set-cookie'];

    if (Array.isArray(setCookie)) {
      cookies = setCookie.map(cookie => cookie.split(';')[0]).join('; ');
    }
  }

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  if (csrfToken) {
    headers['X-CSRF-Token'] = csrfToken;
  }

  if (cookies) {
    headers.Cookie = cookies;
  }

  await executeHttpRequest(
    { destinationName: CPI_DESTINATION },
    {
      method: 'PUT',
      url: endpoint,
      headers,
      data: {
        Id: iflowId,
        ArtifactContent: zipBase64,
      },
    }
  );

  return {
    success: true,
    message: 'Artifact successfully deployed to SAP CPI.',
  };
}

module.exports = cds.service.impl(function () {
  this.on('health', () => 'CPI Utility Hub CAP backend is running');

  this.on('analyzeArtifact', async req => {
    const { fileName, zipBase64 } = req.data;

    if (!fileName || !zipBase64) {
      return req.reject(400, 'fileName and zipBase64 are required.');
    }

    if (!fileName.toLowerCase().endsWith('.zip')) {
      return req.reject(400, 'Only SAP CPI ZIP artifacts are supported.');
    }

    return analyzeZip(fileName, zipBase64);
  });

  this.on('generateArtifact', async req => {
    const { fileName, zipBase64, renames } = req.data;

    if (!fileName || !zipBase64) {
      return req.reject(400, 'fileName and zipBase64 are required.');
    }

    if (!fileName.toLowerCase().endsWith('.zip')) {
      return req.reject(400, 'Only SAP CPI ZIP artifacts are supported.');
    }

    try {
      return await generateZip(fileName, zipBase64, renames);
    } catch (error) {
      return req.reject(error.statusCode || 500, error.message);
    }
  });

  this.on('downloadFromCpi', async req => {
    const { iflowId } = req.data;

    if (!iflowId) {
      return req.reject(400, 'iFlow ID is required.');
    }

    try {
      return await downloadFromCpi(iflowId);
    } catch (error) {
      return req.reject(error?.response?.status || 500, getCpiErrorMessage(error, 'Failed to download artifact from SAP CPI.'));
    }
  });

  this.on('deployToCpi', async req => {
    const { iflowId, zipBase64, comment } = req.data;

    if (!iflowId || !zipBase64) {
      return req.reject(400, 'iFlow ID and zipBase64 are required.');
    }

    try {
      console.log('Deploy comment:', comment || 'No comment provided');
      return await deployToCpi(iflowId, zipBase64, comment);
    } catch (error) {
      console.error('downloadFromCpi failed', {
        message: error.message,
        status: error?.response?.status,
        statusText: error?.response?.statusText,
        data: error?.response?.data,
        cause: error?.cause?.message
      });
      return req.reject(error?.response?.status || 500, getCpiErrorMessage(error, 'Failed to download artifact from SAP CPI.'));
    }
  });
});
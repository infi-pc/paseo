import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sha256Hex } from "./crypto.js";

const execFileAsync = promisify(execFile);

/**
 * Generates an Expo Updates code-signing RSA-2048 keypair and self-signed X.509
 * certificate (PEM) compatible with expo-updates native code signing (`rsa-v1_5-sha256`).
 */
export async function generateExpoCodeSigningPair(outputDir: string): Promise<{
  privateKeyPath: string;
  certificatePath: string;
  keyId: string;
}> {
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const privateKeyPath = path.join(outputDir, "expo-codesign.private.pem");
  const certificatePath = path.join(outputDir, "expo-codesign.cert.pem");

  // OpenSSL is standard on macOS/Linux and emits a standards-compliant X.509 v3 cert
  // with codeSigning extendedKeyUsage required by expo-updates.
  const tmpConf = path.join(os.tmpdir(), `expo-codesign-${process.pid}-${Date.now()}.cnf`);
  await fs.writeFile(
    tmpConf,
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = v3_ext",
      "prompt = no",
      "[dn]",
      "CN = Editable Paseo Personal OTA",
      "[v3_ext]",
      "basicConstraints = CA:FALSE",
      "keyUsage = digitalSignature",
      "extendedKeyUsage = codeSigning",
    ].join("\n") + "\n",
    "utf8",
  );

  try {
    await execFileAsync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      privateKeyPath,
      "-out",
      certificatePath,
      "-days",
      "3650",
      "-config",
      tmpConf,
    ]);
    await fs.chmod(privateKeyPath, 0o600);
    await fs.chmod(certificatePath, 0o644);
  } finally {
    await fs.rm(tmpConf, { force: true });
  }

  return {
    privateKeyPath,
    certificatePath,
    keyId: "main",
  };
}

/**
 * Signs exact Expo Updates manifest bytes using RSA-PKCS1v15-SHA256 and formats
 * the RFC 8941 structured dictionary header expected by `expo-updates`.
 */
export function signExpoManifestBytes(
  manifestBytes: Buffer,
  rsaPrivateKeyPem: string,
  keyId = "main",
): string {
  const sig = crypto
    .sign("sha256", manifestBytes, {
      key: rsaPrivateKeyPem,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    })
    .toString("base64");
  return `sig=:${sig}:, keyid="${keyId}", alg="rsa-v1_5-sha256"`;
}

export function verifyExpoManifestBytes(
  manifestBytes: Buffer,
  expoSignatureHeader: string,
  certificatePem: string,
): boolean {
  const match = /sig=:([A-Za-z0-9+/=]+):/.exec(expoSignatureHeader);
  if (!match?.[1]) return false;
  const sig = Buffer.from(match[1], "base64");
  return crypto.verify(
    "sha256",
    manifestBytes,
    {
      key: certificatePem,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    sig,
  );
}

export interface ExpoUpdateAssetDescriptor {
  hash: string; // base64url SHA-256 (per Expo Updates v1 spec)
  sha256Hex: string; // hex SHA-256 (used as R2 asset path)
  key: string;
  fileExtension: string;
  contentType: string;
  url: string;
  localPath: string;
}

export interface ExpoUpdatesV1Manifest {
  id: string;
  createdAt: string;
  runtimeVersion: string;
  launchAsset: Omit<ExpoUpdateAssetDescriptor, "sha256Hex" | "localPath">;
  assets: Array<Omit<ExpoUpdateAssetDescriptor, "sha256Hex" | "localPath">>;
  metadata: Record<string, string>;
  extra: Record<string, unknown>;
}

function sha256Base64Url(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("base64url");
}

function inferContentType(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".hbc":
    case ".js":
      return "application/javascript";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".svg":
      return "image/svg+xml";
    case ".ttf":
      return "font/ttf";
    case ".otf":
      return "font/otf";
    case ".woff2":
      return "font/woff2";
    case ".json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

/**
 * Builds an Expo Updates Protocol v1 manifest from an `expo export --platform ios`
 * output directory (which contains `metadata.json`, `_expo/static/js/ios/*.hbc`, and `assets/*`).
 */
export async function buildExpoIosManifestFromExport(options: {
  exportDir: string;
  runtimeVersion: string;
  releaseDigest: string;
  sourceSha: string;
  cloudShelfBaseUrl: string;
  summary: string;
  createdAt?: string;
}): Promise<{
  manifest: ExpoUpdatesV1Manifest;
  manifestBytes: Buffer;
  uploadAssets: ExpoUpdateAssetDescriptor[];
}> {
  const metadataPath = path.join(options.exportDir, "metadata.json");
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as {
    fileMetadata?: {
      ios?: {
        bundle: string;
        assets?: Array<{ path: string; ext: string }>;
      };
    };
  };
  const iosMeta = metadata.fileMetadata?.ios;
  if (!iosMeta?.bundle) {
    throw new Error(
      `Expo export metadata.json missing fileMetadata.ios.bundle in ${options.exportDir}`,
    );
  }

  const base = options.cloudShelfBaseUrl.replace(/\/+$/, "");
  const assetBaseUrl = `${base}/releases/ios-ota/${options.releaseDigest}/assets`;
  const uploadAssets: ExpoUpdateAssetDescriptor[] = [];

  const bundleLocalPath = path.join(options.exportDir, iosMeta.bundle);
  const bundleBuf = await fs.readFile(bundleLocalPath);
  const bundleShaHex = sha256Hex(bundleBuf);
  const bundleExt = path.extname(iosMeta.bundle) || ".hbc";
  const launchAssetFull: ExpoUpdateAssetDescriptor = {
    hash: sha256Base64Url(bundleBuf),
    sha256Hex: bundleShaHex,
    key: bundleShaHex,
    fileExtension: bundleExt,
    contentType: inferContentType(bundleExt),
    url: `${assetBaseUrl}/${bundleShaHex}`,
    localPath: bundleLocalPath,
  };
  uploadAssets.push(launchAssetFull);

  const manifestAssets: ExpoUpdatesV1Manifest["assets"] = [];
  for (const a of iosMeta.assets ?? []) {
    const localPath = path.join(options.exportDir, a.path);
    const buf = await fs.readFile(localPath);
    const hex = sha256Hex(buf);
    const ext = a.ext.startsWith(".") ? a.ext : `.${a.ext}`;
    const desc: ExpoUpdateAssetDescriptor = {
      hash: sha256Base64Url(buf),
      sha256Hex: hex,
      key: hex,
      fileExtension: ext,
      contentType: inferContentType(ext),
      url: `${assetBaseUrl}/${hex}`,
      localPath,
    };
    uploadAssets.push(desc);
    manifestAssets.push({
      hash: desc.hash,
      key: desc.key,
      fileExtension: desc.fileExtension,
      contentType: desc.contentType,
      url: desc.url,
    });
  }

  // Deterministic UUID v4-shaped ID derived from releaseDigest so repeat builds keep stable ID
  const d = options.releaseDigest;
  const updateId = `${d.slice(0, 8)}-${d.slice(8, 12)}-4${d.slice(13, 16)}-a${d.slice(17, 20)}-${d.slice(20, 32)}`;

  const manifest: ExpoUpdatesV1Manifest = {
    id: updateId,
    createdAt: options.createdAt ?? new Date().toISOString(),
    runtimeVersion: options.runtimeVersion,
    launchAsset: {
      hash: launchAssetFull.hash,
      key: launchAssetFull.key,
      fileExtension: launchAssetFull.fileExtension,
      contentType: launchAssetFull.contentType,
      url: launchAssetFull.url,
    },
    assets: manifestAssets,
    metadata: {
      sourceSha: options.sourceSha,
      releaseDigest: options.releaseDigest,
      summary: options.summary.slice(0, 200),
    },
    extra: {
      expoClient: {
        name: "Paseo Personal",
        slug: "infi-paseo",
      },
    },
  };

  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  return { manifest, manifestBytes, uploadAssets };
}

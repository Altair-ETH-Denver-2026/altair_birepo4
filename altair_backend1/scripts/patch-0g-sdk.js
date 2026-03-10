#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Patches @0glabs/0g-ts-sdk to match the current 0G Galileo testnet contract ABI.
 *
 * The Submission struct was updated on-chain to add an `address submitter` field,
 * changing the submit() selector from 0xef3e12dc -> 0xbc8c11f8.
 *
 * See reference:
 * https://github.com/MattWong-ca/ethdenver-2026/blob/main/templates/storage/scripts/patch-0g-sdk.js
 */

const fs = require('fs');
const path = require('path');

const SDK = '@0glabs/0g-ts-sdk';

function findSdkRoot() {
  const candidates = [
    path.join(__dirname, '..', 'node_modules', SDK),
    path.join(__dirname, '..', 'packages', 'web', 'node_modules', SDK),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const OLD_SUBMIT_ABI = `                components: [
                    {
                        internalType: "uint256",
                        name: "length",
                        type: "uint256",
                    },
                    {
                        internalType: "bytes",
                        name: "tags",
                        type: "bytes",
                    },
                    {
                        components: [
                            {
                                internalType: "bytes32",
                                name: "root",
                                type: "bytes32",
                            },
                            {
                                internalType: "uint256",
                                name: "height",
                                type: "uint256",
                            },
                        ],
                        internalType: "struct SubmissionNode[]",
                        name: "nodes",
                        type: "tuple[]",
                    },
                ],`;

const NEW_SUBMIT_ABI = `                components: [
                    {
                        components: [
                            {
                                internalType: "uint256",
                                name: "length",
                                type: "uint256",
                            },
                            {
                                internalType: "bytes",
                                name: "tags",
                                type: "bytes",
                            },
                            {
                                components: [
                                    {
                                        internalType: "bytes32",
                                        name: "root",
                                        type: "bytes32",
                                    },
                                    {
                                        internalType: "uint256",
                                        name: "height",
                                        type: "uint256",
                                    },
                                ],
                                internalType: "struct SubmissionNode[]",
                                name: "nodes",
                                type: "tuple[]",
                            },
                        ],
                        internalType: "struct SubmissionData",
                        name: "data",
                        type: "tuple",
                    },
                    {
                        internalType: "address",
                        name: "submitter",
                        type: "address",
                    },
                ],`;

const OLD_UPLOADER_LINE = `[submission], txOpts, retryOpts)`;
const NEW_UPLOADER_LINE = `[{ data: submission, submitter: await this.flow.runner.getAddress() }], txOpts, retryOpts)`;

// Galileo currently emits the legacy Submit event topic; keep event ABI old for log decoding.
const NEW_EVENT_SUBMISSION_ABI = `                components: [
                    {
                        components: [
                            {
                                internalType: "uint256",
                                name: "length",
                                type: "uint256",
                            },
                            {
                                internalType: "bytes",
                                name: "tags",
                                type: "bytes",
                            },
                            {
                                components: [
                                    {
                                        internalType: "bytes32",
                                        name: "root",
                                        type: "bytes32",
                                    },
                                    {
                                        internalType: "uint256",
                                        name: "height",
                                        type: "uint256",
                                    },
                                ],
                                internalType: "struct SubmissionNode[]",
                                name: "nodes",
                                type: "tuple[]",
                            },
                        ],
                        internalType: "struct SubmissionData",
                        name: "data",
                        type: "tuple",
                    },
                    {
                        internalType: "address",
                        name: "submitter",
                        type: "address",
                    },
                ],
                indexed: false,
                internalType: "struct Submission",
                name: "submission",
                type: "tuple",`;

const OLD_EVENT_SUBMISSION_ABI = `                components: [
                    {
                        internalType: "uint256",
                        name: "length",
                        type: "uint256",
                    },
                    {
                        internalType: "bytes",
                        name: "tags",
                        type: "bytes",
                    },
                    {
                        components: [
                            {
                                internalType: "bytes32",
                                name: "root",
                                type: "bytes32",
                            },
                            {
                                internalType: "uint256",
                                name: "height",
                                type: "uint256",
                            },
                        ],
                        internalType: "struct SubmissionNode[]",
                        name: "nodes",
                        type: "tuple[]",
                    },
                ],
                indexed: false,
                internalType: "struct Submission",
                name: "submission",
                type: "tuple",`;

const OLD_TXSEQS_BLOCK = `            receipt = txReceipt;
            console.log('Transaction hash:', receipt.hash);
            const txSeqs = await this.processLogs(receipt);
            if (txSeqs.length === 0) {
                return [
                    { txHash: '', rootHash },
                    new Error('Failed to get txSeqs'),
                ];
            }`;

const NEW_TXSEQS_BLOCK = `            receipt = txReceipt;
            console.log('Transaction hash:', receipt.hash);
            let txSeqs = await this.processLogs(receipt);
            if (txSeqs.length === 0) {
                console.log('No txSeqs in receipt, waiting 5s and re-fetching receipt...');
                await new Promise((r) => setTimeout(r, 5000));
                const freshReceipt = await this.provider.getTransactionReceipt(receipt.hash);
                if (freshReceipt) txSeqs = await this.processLogs(freshReceipt);
            }
            if (txSeqs.length === 0) {
                return [
                    { txHash: receipt.hash || '', rootHash },
                    new Error('Failed to get txSeqs (receipt logs not available yet; try again in a moment)'),
                ];
            }`;

function patchFile(filePath, oldStr, newStr, label, replaceAll = false) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.includes(oldStr)) {
    console.log(`  skip (already patched or no match): ${label}`);
    return;
  }
  const newContent = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
  if (newContent === content) {
    console.log(`  skip (no change): ${label}`);
    return;
  }
  fs.writeFileSync(filePath, newContent);
  console.log(`  patched: ${label}`);
}

const sdkRoot = findSdkRoot();
if (!sdkRoot) {
  console.log('patch-0g-sdk: SDK not found, skipping.');
  process.exit(0);
}

console.log(`patch-0g-sdk: found SDK at ${sdkRoot}`);

for (const variant of ['lib.esm', 'lib.commonjs']) {
  const factoryPath = path.join(sdkRoot, variant, 'contracts', 'flow', 'factories', 'FixedPriceFlow__factory.js');
  const uploaderPath = path.join(sdkRoot, variant, 'transfer', 'Uploader.js');
  patchFile(factoryPath, OLD_SUBMIT_ABI, NEW_SUBMIT_ABI, `${variant}/FixedPriceFlow__factory.js`, true);
  patchFile(
    factoryPath,
    NEW_EVENT_SUBMISSION_ABI,
    OLD_EVENT_SUBMISSION_ABI,
    `${variant}/FixedPriceFlow__factory.js (Submit event legacy topic)`
  );
  patchFile(uploaderPath, OLD_UPLOADER_LINE, NEW_UPLOADER_LINE, `${variant}/Uploader.js`);
  patchFile(uploaderPath, OLD_TXSEQS_BLOCK, NEW_TXSEQS_BLOCK, `${variant}/Uploader.js (txSeqs retry)`);
}

console.log('patch-0g-sdk: done.');

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { promises as fs } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const securityScript = (name: string) =>
  pathToFileURL(path.join(homedir(), ".agents", "skills", "security", "scripts", name)).href;

export default async function (pi: ExtensionAPI) {
  const [
    { getFilesToAudit, getAuditScope, getLineCount },
    { findLineNumbers },
    { parseMarkdownToDict },
    { getSecurityPatchContext, getPocContext, getRunPoc, getInstallDependencies },
    { SECURITY_DIR_NAME },
  ] = await Promise.all([
    import(securityScript("filesystem.ts")),
    import(securityScript("security.ts")),
    import(securityScript("parser.ts")),
    import(securityScript("tools.ts")),
    import(securityScript("constants.ts")),
  ]);

  // 1. Register security:analyze slash command
  pi.registerCommand("security:analyze", {
    description: "Scan code changes of the current branch for security vulnerabilities",
    handler: async (args, ctx) => {
      ctx.ui.notify("Checking security audit scope...", "info");
      const diff = getAuditScope();
      if (!diff) {
        ctx.ui.notify("No local git modifications found to scan on this branch.", "warning");
      }

      const proceed = await ctx.ui.confirm(
        "Start Security Audit",
        "This will perform an automated security analysis of code changes using the 'security-auditor' Standard Operating Procedures.\nDo you want to proceed?"
      );

      if (!proceed) {
        ctx.ui.notify("Scan cancelled by user.", "warning");
        return;
      }

      // Trigger active agent scan turn by feeding user message
      await pi.sendUserMessage(
        `Perform a comprehensive security scan of this codebase following the 'security-auditor' skill guidelines. ` +
        `Analyze the files in our audit scope (using get_audit_scope and get_files_to_audit if needed). ` +
        `Create a detailed security report in Markdown format at '.security/SECURITY_REPORT.md' ` +
        `and a task tracking file at '.security/SECURITY_ANALYSIS_TODO.md'. ` +
        `Finally, use the 'convert_report_to_json' tool to output a structured JSON report.`
      );
    }
  });

  // 2. Register security:github-pr slash command
  pi.registerCommand("security:github-pr", {
    description: "Review security vulnerabilities in code changes of a GitHub Pull Request",
    handler: async (args, ctx) => {
      const proceed = await ctx.ui.confirm(
        "Start GitHub PR Scan",
        "This will analyze pull request modifications using the 'security-auditor' guidelines.\nDo you want to proceed?"
      );

      if (!proceed) {
        ctx.ui.notify("Scan cancelled.", "warning");
        return;
      }

      await pi.sendUserMessage(
        `Review the security of the code changes in this Pull Request. ` +
        `Retrieve the diff using 'get_audit_scope' (with 'origin/HEAD' or target branches if specified). ` +
        `Perform a thorough analysis based on 'security-auditor' standard operating procedures. ` +
        `Save your report under '.security/SECURITY_REPORT.md'.`
      );
    }
  });

  // 3. Register 'find_line_numbers' custom tool
  pi.registerTool({
    name: "find_line_numbers",
    label: "Find Line Numbers",
    description: "Finds the line numbers of a code snippet in a file.",
    parameters: Type.Object({
      filePath: Type.String({ description: "The path to the file with the security vulnerability." }),
      snippet: Type.String({ description: "The code snippet to search for inside the file." }),
    }),
    async execute(toolCallId, params) {
      return findLineNumbers(params);
    }
  });

  // 4. Register 'get_audit_scope' custom tool
  pi.registerTool({
    name: "get_audit_scope",
    label: "Get Audit Scope",
    description: "Gets the git diff of the current changes. Can optionally compare two specific branches.",
    parameters: Type.Object({
      base: Type.Optional(Type.String({ description: "The base branch or commit hash (e.g., 'main')." })),
      head: Type.Optional(Type.String({ description: "The head branch or commit hash (e.g., 'feature-branch')." })),
    }),
    async execute(toolCallId, params) {
      const diff = getAuditScope(params.base, params.head);
      return {
        content: [{ type: "text", text: diff }],
        details: {},
      };
    }
  });

  // 5. Register 'get_files_to_audit' custom tool
  pi.registerTool({
    name: "get_files_to_audit",
    label: "Get Files to Audit",
    description: "Lists relevant files for auditing by filtering out irrelevant files and folders.",
    parameters: Type.Object({}),
    async execute() {
      const files = getFilesToAudit();
      return {
        content: [{ type: "text", text: files.join("\n") }],
        details: {},
      };
    }
  });

  // 6. Register 'get_line_count' custom tool
  pi.registerTool({
    name: "get_line_count",
    label: "Get Line Count",
    description: "Gets the total line count of a list of files.",
    parameters: Type.Object({
      files: Type.Array(Type.String(), { description: "A list of file paths to count lines for." }),
    }),
    async execute(toolCallId, params) {
      const count = getLineCount(params.files);
      return {
        content: [{ type: "text", text: count.toString() }],
        details: {},
      };
    }
  });

  // 7. Register 'convert_report_to_json' custom tool
  pi.registerTool({
    name: "convert_report_to_json",
    label: "Convert Report to JSON",
    description: `Converts the Markdown security report into a JSON file named security_report.json in the ${SECURITY_DIR_NAME} folder.`,
    parameters: Type.Object({}),
    async execute() {
      try {
        const reportPath = path.join(process.cwd(), `${SECURITY_DIR_NAME}/DRAFT_SECURITY_REPORT.md`);
        const outputPath = path.join(process.cwd(), `${SECURITY_DIR_NAME}/security_report.json`);

        let content = "";
        try {
          content = await fs.readFile(reportPath, "utf-8");
        } catch {
          // If DRAFT_SECURITY_REPORT.md doesn't exist, try reading SECURITY_REPORT.md
          const finalReportPath = path.join(process.cwd(), `${SECURITY_DIR_NAME}/SECURITY_REPORT.md`);
          content = await fs.readFile(finalReportPath, "utf-8");
        }

        const results = parseMarkdownToDict(content);
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, JSON.stringify(results, null, 2));

        return {
          content: [{
            type: "text",
            text: `Successfully created JSON report at ${outputPath}`
          }],
          details: {},
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error converting to JSON: ${message}` }],
          isError: true,
          details: {},
        };
      }
    }
  });

  // 8. Register 'poc_context' custom tool
  pi.registerTool({
    name: "poc_context",
    label: "PoC Context",
    description: "Sets up the necessary workspace and directories to test a vulnerability, returning the context variables needed to generate the PoC. Call this tool as part of the `poc` skill.",
    parameters: Type.Object({
      problemStatement: Type.String({ description: "The raw description of the security problem or vulnerability provided by the user." }),
      vulnerabilityType: StringEnum(["path_traversal", "other"] as const, { description: "Select 'path_traversal' if files can be accessed outside of boundaries, or 'other' for everything else." }),
      sourceCodeLocation: Type.String({ description: "The exact file path and function/line number of the vulnerable code." }),
    }),
    async execute(toolCallId, params) {
      return getPocContext(params);
    }
  });

  // 9. Register 'run_poc' custom tool
  pi.registerTool({
    name: "run_poc",
    label: "Run PoC",
    description: "Runs the generated PoC code.",
    parameters: Type.Object({
      filePath: Type.String({ description: "The absolute path to the PoC file to run." }),
    }),
    async execute(toolCallId, params) {
      return getRunPoc(params);
    }
  });

  // 10. Register 'security_patch_context' custom tool
  pi.registerTool({
    name: "security_patch_context",
    label: "Security Patch Context",
    description: "Fetches context about a security vulnerability in a given file. Do not call this tool directly from a user prompt; instead, you MUST invoke the `security-patcher` skill, which will orchestrate the use of this tool and the patching process.",
    parameters: Type.Object({
      vulnerability: StringEnum(["scan_deps", "path_traversal", "other"] as const, { description: "The type of vulnerability to patch." }),
      filePath: Type.String({ description: "The absolute path to the file that needs patching." }),
      pocFilePath: Type.String({ description: "The absolute path to the PoC file that demonstrates the vulnerability. Empty string if none." }),
      vulnerabilityContext: Type.String({ description: "A description of the vulnerability and where it occurs." }),
    }),
    async execute(toolCallId, params) {
      return getSecurityPatchContext(params);
    }
  });

  // 11. Register 'install_dependencies' custom tool
  pi.registerTool({
    name: "install_dependencies",
    label: "Install Dependencies",
    description: "Executes a dependency installation script inside the workspace.",
    parameters: Type.Object({
      scriptPath: Type.String({ description: "Absolute path to the script file to execute." }),
      targetFile: Type.String({ description: "The target file requiring dependencies." }),
      cwd: Type.Optional(Type.String({ description: "Execution directory (optional. overrides calculation)." })),
    }),
    async execute(toolCallId, params) {
      return getInstallDependencies(params);
    }
  });
}

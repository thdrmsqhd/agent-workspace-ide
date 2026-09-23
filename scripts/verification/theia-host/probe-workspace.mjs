// TV-001/002 검증 작업대를 만든다. Java·Python·아이콘·Git 워크트리 2개를 포함한다.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

export function createIdeProbeWorkspace(name) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const root = join(tmpdir(), `awi-theia-${name}-${stamp}`);
  const javaProject = join(root, "java-project");
  const pythonProject = join(root, "python-project");
  const gitProject = join(root, "git-project");

  writeJavaProject(javaProject);
  writePythonProject(pythonProject);
  writeGitProject(gitProject, root);
  writeFileSync(join(root, "icon.svg"), SVG_ICON);
  writeWorkspaceSettings(root);
  writeFileSync(
    join(root, "probe.json"),
    `${JSON.stringify({ root, javaProject, pythonProject, gitProject, worktrees: [join(root, "worktree-a"), join(root, "worktree-b")] }, null, 2)}\n`,
  );
  return { root, javaProject, pythonProject, gitProject, worktreeA: join(root, "worktree-a"), worktreeB: join(root, "worktree-b") };
}

function writeJavaProject(project) {
  mkdirSync(join(project, "src", "main", "java", "demo"), { recursive: true });
  writeFileSync(join(project, "pom.xml"), POM);
  writeFileSync(
    join(project, "src", "main", "java", "demo", "App.java"),
    [
      "package demo;",
      "",
      "public final class App {",
      "    private App() {}",
      "",
      "    public static void main(String[] args) {",
      "        Greeter greeter = new Greeter();",
      "        String greeting = greeter.greet(\"검증\", 3);",
      "        int total = 0;",
      "        for (int index = 0; index < greeting.length(); index++) {",
      "            total += greeting.charAt(index);",
      "        }",
      "        System.out.println(greeting + \" / \" + total);",
      "    }",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(project, "src", "main", "java", "demo", "Greeter.java"),
    [
      "package demo;",
      "",
      "public class Greeter {",
      "    /** 이름을 반복해 인사 문자열을 만든다. 이름 변경(rename) 대상이다. */",
      "    public String greet(String name, int repeat) {",
      "        StringBuilder builder = new StringBuilder();",
      "        for (int index = 0; index < repeat; index++) {",
      "            builder.append(\"안녕 \").append(name).append(\" #\").append(index + 1).append(\"\\n\");",
      "        }",
      "        return builder.toString();",
      "    }",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(join(project, "README.md"), "# Java 검증 프로젝트\n\nTV-001의 중단점·지역 변수·자동완성·선언 이동·진단·이름 변경 대상이다.\n");
}

function writePythonProject(project) {
  mkdirSync(join(project, "pkg"), { recursive: true });
  writeFileSync(
    join(project, "main.py"),
    [
      "\"\"\"TV-001 Python 검증 진입점.\"\"\"",
      "",
      "from pkg.helper import build_report, count_words",
      "",
      "",
      "def main() -> None:",
      "    report: str = build_report(\"검증 문장 하나\", \"검증 문장 둘\")",
      "    words: int = count_words(report)",
      "    print(report)",
      "    print(words)",
      "",
      "",
      "if __name__ == \"__main__\":",
      "    main()",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(project, "pkg", "helper.py"),
    [
      "\"\"\"교차 모듈 자동완성·선언 이동 대상.\"\"\"",
      "",
      "",
      "def normalize(text: str) -> str:",
      "    return \" \".join(text.split())",
      "",
      "",
      "def build_report(*lines: str) -> str:",
      "    return \"\\n\".join(normalize(line) for line in lines)",
      "",
      "",
      "def count_words(text: str) -> int:",
      "    return len([word for word in text.split(\" \") if word])",
      "",
    ].join("\n"),
  );
  writeFileSync(join(project, "README.md"), "# Python 검증 프로젝트\n\n교차 모듈 자동완성·선언 이동·진단 확인 대상이다.\n");
}

function writeGitProject(project, root) {
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(project, "docs", "공백 경로"), { recursive: true });
  mkdirSync(join(project, "assets"), { recursive: true });
  writeFileSync(join(project, "src", "demo.txt"), "A worktree base\n두 번째 줄\n셋째 줄\n");
  writeFileSync(join(project, "docs", "공백 경로", "메모.md"), "# 공백·한글 경로 파일\n");
  writeFileSync(join(project, "assets", "tiny.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
  run(project, ["init", "-q", "-b", "main"]);
  run(project, ["config", "user.email", "verification@example.invalid"]);
  run(project, ["config", "user.name", "awi-verification"]);
  run(project, ["add", "-A"]);
  run(project, ["commit", "-q", "-m", "probe: initial"]);
  run(project, ["branch", "feature/two"]);
  run(project, ["worktree", "add", join(root, "worktree-a"), "-b", "probe/a"]);
  run(project, ["worktree", "add", join(root, "worktree-b"), "-b", "probe/b"]);
  // 두 워크트리에 같은 상대 경로 파일을 서로 다른 내용으로 둔다(TV-002 교차 선택 대상).
  writeFileSync(join(root, "worktree-a", "src", "demo.txt"), "A worktree A content\nWRONG-FOR-B\n");
  writeFileSync(join(root, "worktree-b", "src", "demo.txt"), "B worktree B content\nWRONG-FOR-A\n");
}

function run(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
}

/** 작업대 설정: 워크스페이스 신뢰를 끄고 Java 확장에 JDK 21을 알려준다. */
function writeWorkspaceSettings(root) {
  const settings = {
    "security.workspace.trust.enabled": false,
    "java.jdt.ls.java.home": JAVA_HOME.replace(/\\/gu, "/"),
    "java.configuration.runtimes": [{ name: "JavaSE-21", path: JAVA_HOME.replace(/\\/gu, "/"), default: true }],
    "java.import.maven.enabled": true,
    "files.autoSave": "off",
    "telemetry.telemetryLevel": "off",
  };
  const body = `${JSON.stringify(settings, null, 2)}\n`;
  mkdirSync(join(root, ".theia"), { recursive: true });
  mkdirSync(join(root, ".vscode"), { recursive: true });
  writeFileSync(join(root, ".theia", "settings.json"), body);
  writeFileSync(join(root, ".vscode", "settings.json"), body);
}

const JAVA_HOME = join(homedir(), ".jdks", "jdk-21.0.12.1+1");

export function javaHome() {
  const candidate = join(homedir(), ".jdks", "jdk-21.0.12.1+1");
  return candidate;
}

const POM = [
  "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
  "<project xmlns=\"http://maven.apache.org/POM/4.0.0\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xsi:schemaLocation=\"http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd\">",
  "  <modelVersion>4.0.0</modelVersion>",
  "  <groupId>demo</groupId>",
  "  <artifactId>probe</artifactId>",
  "  <version>0.0.0</version>",
  "  <properties>",
  "    <maven.compiler.release>21</maven.compiler.release>",
  "    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>",
  "  </properties>",
  "</project>",
  "",
].join("\n");

const SVG_ICON = [
  "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"32\" height=\"32\" viewBox=\"0 0 32 32\">",
  "  <rect width=\"32\" height=\"32\" rx=\"6\" fill=\"#1f6feb\"/>",
  "  <path d=\"M8 22 L16 8 L24 22 Z\" fill=\"#ffffff\"/>",
  "</svg>",
  "",
].join("\n");

// 직접 실행하면 작업대를 만들고 경로를 출력한다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const workspace = createIdeProbeWorkspace(process.argv[2] ?? "tv001");
  process.stdout.write(`${JSON.stringify(workspace, null, 2)}\n`);
}

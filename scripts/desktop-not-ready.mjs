import process from "node:process";

process.stderr.write(
  "데스크톱 앱은 아직 구현되지 않았습니다. IMP-02에서 IDE 기반 검증 후 개발 실행 명령을 연결합니다.\n",
);
process.exitCode = 1;

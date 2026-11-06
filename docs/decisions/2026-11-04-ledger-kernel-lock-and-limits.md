---
status: accepted
supersedes: "[[2026-11-04-reusable-migration-probes]]"
supersedes_scope: "ADR-0001의 ledger 잠금(20-21행)과 기본 상한(27행)만"
---

# ADR-0002: 봇 ledger의 단일 writer를 커널 flock으로 보장하고 상한을 낮춤

## Context

ADR-0001은 봇 ledger에 "표준 filesystem lease"(proper-lockfile)와
100000건/64MiB 기본 상한을 정했다. 재검수에서 두 문제가 나왔다.

- lease는 시간으로 만료된다. 멈춘(SIGSTOP·hang) writer가 만료 뒤 재개하면
  새 writer와 같은 ledger를 동시에 쓸 수 있다(설계 H5).
- 만료 없는 디렉터리 잠금으로 바꾸면 OOMKill·crash처럼 `close()`가 돌지
  못한 뒤 같은 Pod에서 재시작할 때 잠금이 남아 CrashLoopBackOff에 빠진다.
  그러면 「재시작 후 미확인 요청을 재처리한다」는 불변식이 깨진다(H7).
- JSON snapshot은 쓸 때마다 전체를 다시 쓰므로 64MiB에서는 persist 비용과
  메모리가 크다.

hostname·PID로 소유자 사망을 추정하는 안은 같은 Pod의 컨테이너가 hostname을
공유하고 PID namespace가 분리돼 있어 살아 있는 writer를 죽었다고 오판할 수
있다. 그래서 채택하지 않는다.

## Decision

- ledger 디렉터리 안의 일반 파일 `.owner.lock`을
  `O_RDWR|O_CREAT|O_NOFOLLOW`, 0600으로 연다. 그 FD를 자식 fd3으로 넘겨
  `flock -n -x 3`을 한 번 실행하고, 부모가 FD를 닫을 때까지 보관한다.
- 잠금 직후 같은 경로를 따로 연 FD로 비차단 잠금을 다시 시도한다. 그것도
  성공하면 helper가 잠금을 유지하지 못한 환경이므로 거절한다.
- 잠금 파일은 unlink·rename하지 않는다. ledger rename 직전마다 보관 FD와
  경로의 dev/ino가 같은지 확인한다.
- 시간·mtime·PID·hostname으로 잠금을 빼앗는 경로는 없다. 해제는 정상
  `close()` 또는 프로세스 종료 시 커널의 FD 정리 둘뿐이다.
- 오류 코드는 네 가지다. 셋은 ledger를 바꾸기 전에 시작을 거절한다.
    - `LEDGER_OWNED`: 다른 writer가 잠금을 쥐고 있다.
    - `LEDGER_LOCK_UNSUPPORTED`: flock(1)이 없거나 비정상 종료, 잠금이
      유지되지 않음, symlink 등 안전하게 획득할 수 없는 경로.
    - `LEDGER_LEGACY_LOCK`: 옛 proper-lockfile 잠금 디렉터리가 남아 있다.
- `LEDGER_LOCK_LOST`는 시작 거절이 아니다. 실행 중 다음 ledger 저장의
  rename 직전에 잠금 파일이 외부에서 교체·삭제된 것을 발견하면 그 저장을
  게시하지 않고 봇을 fatal로 멈춘다(요약 `fatal`, CLI 종료 코드 1). 그 전에
  처리한 기록은 이미 ledger에 있을 수 있다.
- `lockRetries` 옵션과 proper-lockfile 의존을 없앤다. 재시도는 kubelet
  재시작 backoff가 맡는다.
- 기본 상한은 라이브러리·CLI·매니페스트 모두 10000건/8MiB로 맞춘다.
  1건/s에서 건수 상한은 약 2시간 47분이다. 이론값이며 장시간 운영 보장이
  아니다.
- 새 ledger에는 새 run_id를 쓴다. 지운 ledger의 run_id를 다시 쓰지 않는다.

## Alternatives Considered

- 만료 없는 mkdir 잠금 + 수동 `recover-lock`: crash 뒤 CrashLoop에 빠진다.
- proper-lockfile lease 유지: 만료 뒤 멈췄던 writer가 재개할 수 있다.
- hostname·PID 사망 추정: PID namespace 분리와 PID 재사용을 증명하지 못한다.
- 네이티브 flock·fcntl addon: 빌드 의존과 공급망 부담이 는다.
- ReadWriteOncePod: CSI 지원이 미확인이며 보완책일 뿐 대체가 아니다.
- 상한 64MiB + 경고: persist 비용 문제를 남긴다.

## Consequences

- 같은 Pod 안 crash·OOM 뒤 재시작은 수동 개입 없이 잠금을 다시 얻고
  pending부터 처리한다. 멈춘 writer는 새 writer를 계속 막는다. 이는 의도한
  fail-closed이며 liveness kill이나 운영자 종료로만 회복한다.
- 지원 범위가 좁아진다. 봇 SDK·CLI는 Linux 단일 노드의 로컬 FS 또는 RWO
  블록 볼륨과 flock(1)이 필요하다. 봇 컨테이너 이미지 `node:22-alpine`에는
  들어 있다. macOS 호스트, NFS·EFS·RWX, cross-node 강제 detach는 보장 밖이다.
  옛 노드의 종료·fencing 확인은 외부 운영 조건이다.
- request-store DB API에는 OS 제약이 새로 생기지 않는다. 패키지 `os`
  필드는 설정하지 않고, 미지원 환경에서는 시작 때 명시적으로 실패한다.
- 잠금은 협력적 advisory 잠금이다. 권한 있는 외부 프로세스의 lockfile
  수동 교체나 비협력 writer는 막지 못한다. dev/ino 검사는 교체를 감지할 뿐
  확인과 rename 사이의 경합은 닫지 못한다.
- 옛 lease 봇과 새 봇을 같은 ledger에서 동시에 띄우지 않는다. 업그레이드
  때 남은 `<ledger 디렉터리>.lock`은 자동 삭제하지 않는다. 옛 봇 종료를
  확인한 뒤 일회성 복구 Job으로 빈 디렉터리만 지운다
  (`k8s/traffic-bot/legacy-lock-recovery-job.yaml`).
- `lockRetries` 삭제가 기존 호출자를 깨는지는 0.1.0 게시 여부에 달렸고,
  게시 여부는 미확인이다.
- etcd·Prometheus·LevelDB 같은 외부 제품의 잠금 구현은 조사하지 않았다.
  근거는 flock(2) 정본과 실제 Linux 프로세스 시험이다.

## 관련

- [flock(2) Linux man-pages](https://man7.org/linux/man-pages/man2/flock.2.html)
- [ADR-0001](2026-11-04-reusable-migration-probes.md)
- [배포 안내](../deployment.md)
- [traffic-bot README](../../packages/traffic-bot/README.md)

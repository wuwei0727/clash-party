# Clash Party 本地功能安全更新上游代码流程

本文档适用于当前仓库结构：

```text
当前本地自定义分支: custom
你的远程仓库: origin -> https://github.com/wuwei0727/clash-party.git
原项目远程仓库: upstream -> https://github.com/mihomo-party-org/clash-party.git
推荐更新目标分支: upstream/smart_core
```

目标：

```text
在保留自己本地功能代码的前提下，把 upstream 远程分支的新代码合并进来。
```

核心原则：

```text
1. 不要直接 git pull。
2. 不要使用 git reset --hard。
3. 更新前一定先提交并备份自己的本地改动。
4. 所有合并操作先在临时 update 分支完成，确认没问题后再合回 custom。
```

## 0. 进入项目目录

PowerShell:

```powershell
cd D:\cusor项目\clash-party\clash-party-up
```

Git Bash / WSL:

```bash
cd /mnt/d/cusor项目/clash-party/clash-party-up
```

## 1. 检查当前状态

```bash
git status -sb
git branch -vv
git remote -v
```

确认当前分支是：

```text
custom
```

如果看到很多 `M` 或 `??`，说明有未提交改动。继续执行下面的备份流程。

## 2. 生成补丁备份

这一步是额外保险，用来保存当前已跟踪文件的修改内容。

```bash
git diff > local-changes-before-update.patch
```

保存未跟踪文件列表：

```bash
git ls-files --others --exclude-standard > untracked-files-before-update.txt
```

说明：

```text
git diff 只会保存已被 Git 跟踪文件的修改。
新增文件，也就是 git status 中显示 ?? 的文件，不会自动包含在 patch 中。
所以需要额外保存 untracked-files-before-update.txt。
```

## 3. 创建本地备份分支

从当前 `custom` 分支创建一个备份分支：

```bash
git switch -c backup/custom-before-update-20260429
```

如果日期不是 2026-04-29，可以把分支名改成当天日期，例如：

```bash
git switch -c backup/custom-before-update-20260501
```

## 4. 提交自己的本地功能代码

把所有当前改动加入暂存区：

```bash
git add -A
```

提交：

```bash
git commit -m "wip: save local custom changes before upstream update"
```

检查是否干净：

```bash
git status -sb
```

理想结果类似：

```text
## backup/custom-before-update-20260429
nothing to commit, working tree clean
```

如果还有未提交内容，先处理完再继续。

## 5. 推送备份分支到自己的远程仓库

```bash
git push -u origin backup/custom-before-update-20260429
```

这一步完成后，即使本地操作失误，GitHub 上也有一份备份分支。

## 6. 回到 custom 分支

```bash
git switch custom
```

如果 `custom` 分支还没有刚才的备份提交，可以把备份分支合并回来：

```bash
git merge backup/custom-before-update-20260429
```

检查：

```bash
git log --oneline --decorate -5
git status -sb
```

确认能看到：

```text
wip: save local custom changes before upstream update
```

并且工作区是干净的。

## 7. 创建上游更新临时分支

不要直接在 `custom` 分支上合并上游代码，先创建一个临时更新分支：

```bash
git switch -c update/upstream-smart-core-20260429
```

如果日期不同，也可以改成当天日期：

```bash
git switch -c update/upstream-smart-core-20260501
```

## 8. 拉取 upstream 最新代码

```bash
git fetch upstream
```

查看远程分支：

```bash
git branch -r
```

查看当前分支和上游目标分支的差异：

```bash
git log --oneline --left-right --graph HEAD...upstream/smart_core
```

查看双方提交数量差异：

```bash
git rev-list --left-right --count HEAD...upstream/smart_core
```

输出示例：

```text
1 34
```

含义：

```text
左边 1: 你本地有、upstream/smart_core 没有的提交数量。
右边 34: upstream/smart_core 有、你本地没有的提交数量。
```

## 9. 合并 upstream/smart_core

在 `update/upstream-smart-core-20260429` 分支上执行：

```bash
git merge upstream/smart_core
```

如果没有冲突，Git 会自动完成合并。

如果出现冲突，会看到类似：

```text
CONFLICT (content): Merge conflict in src/xxx.ts
Automatic merge failed; fix conflicts and then commit the result.
```

出现冲突时，继续执行第 10 步。

## 10. 查看冲突文件

查看整体状态：

```bash
git status -sb
```

只列出冲突文件：

```bash
git diff --name-only --diff-filter=U
```

冲突状态常见标记：

```text
UU: 双方都修改了同一个文件，需要手动解决。
AA: 双方都新增了同名文件，需要手动选择或合并。
DD: 双方都删除或移动相关文件，需要确认最终状态。
```

## 11. 手动解决冲突

打开冲突文件，会看到类似内容：

```text
<<<<<<< HEAD
这里是你本地 update 分支中的代码，也就是你的自定义功能代码
=======
这里是 upstream/smart_core 远程分支中的新代码
>>>>>>> upstream/smart_core
```

处理原则：

```text
1. 你的新增功能代码要保留。
2. upstream 的 bug 修复、依赖升级、结构调整也尽量合进来。
3. 不要简单只选 HEAD 或只选 upstream，要根据实际逻辑合成最终代码。
4. package.json 冲突时，通常需要保留双方新增的依赖、脚本和版本改动。
5. pnpm-lock.yaml 冲突时，可以先解决 package.json，再执行 pnpm install 重新生成 lockfile。
```

解决完一个文件后，把它加入暂存区：

```bash
git add 文件路径
```

示例：

```bash
git add package.json
git add src/main/index.ts
git add src/renderer/src/App.tsx
```

全部冲突解决完成后再次检查：

```bash
git status -sb
git diff --name-only --diff-filter=U
```

如果第二个命令没有输出，说明冲突文件已经全部解决。

## 12. 提交合并结果

```bash
git commit -m "merge upstream smart_core into custom update branch"
```

如果 Git 自动打开编辑器并生成了 merge commit 信息，也可以直接保存退出。

## 13. 安装依赖

本项目使用 `pnpm`，不要使用 `npm install`。

```bash
pnpm install
```

如果提示没有 `pnpm`，在 PowerShell 中执行：

```powershell
corepack enable
corepack prepare pnpm@10.27.0 --activate
pnpm install
```

## 14. 检查代码

类型检查：

```bash
pnpm run typecheck
```

Lint 检查：

```bash
pnpm run lint:check
```

也可以执行项目已有的综合检查：

```bash
pnpm run review
```

开发运行：

```bash
pnpm run dev
```

Windows 打包：

```bash
pnpm run build:win
```

注意：这个项目是 Electron 项目，不是 Tauri 项目，所以不要执行：

```bash
npm run tauri build
```

正确的 Windows 构建命令是：

```bash
pnpm run build:win
```

## 15. 如果检查后有新改动，提交它们

例如 `pnpm install` 修改了 `pnpm-lock.yaml`，或者你修复了冲突后的代码问题：

```bash
git status -sb
git add -A
git commit -m "fix: resolve issues after upstream update"
```

## 16. 确认更新分支状态

```bash
git log --oneline --decorate --graph -20
git status -sb
```

理想状态：

```text
当前分支是 update/upstream-smart-core-20260429
工作区干净
项目可以 pnpm run dev
项目可以 pnpm run build:win
自己的功能还在
upstream 新代码也已经合进来
```

## 17. 合并回 custom 分支

确认 `update/upstream-smart-core-20260429` 没问题后：

```bash
git switch custom
git merge update/upstream-smart-core-20260429
```

推送到自己的远程仓库：

```bash
git push origin custom
```

## 18. 可选：推送更新临时分支

如果你想在远程也保留这次更新过程：

```bash
git push -u origin update/upstream-smart-core-20260429
```

## 19. 如果合并过程中想放弃

如果执行 `git merge upstream/smart_core` 后出现大量冲突，而且还没有提交 merge，可以取消本次合并：

```bash
git merge --abort
```

然后回到备份分支：

```bash
git switch backup/custom-before-update-20260429
```

或者重新创建一个新的更新分支再试：

```bash
git switch backup/custom-before-update-20260429
git switch -c update/upstream-smart-core-retry-20260429
git fetch upstream
git merge upstream/smart_core
```

## 20. 禁止直接执行的高风险命令

当前仓库有你自己的功能改动时，不要执行以下命令：

```bash
git reset --hard
git checkout .
git clean -fd
git pull
git pull --rebase
git reset --hard upstream/smart_core
```

原因：

```text
这些命令可能会覆盖或丢弃你的本地功能代码。
尤其是 git reset --hard upstream/smart_core，会把当前分支强制改成 upstream/smart_core 的状态。
如果你的功能代码没有提交或备份，就会丢失。
```

## 21. 最短安全命令清单

如果你确认当前所有本地改动都要保留，可以按下面顺序执行。

```bash
cd /mnt/d/cusor项目/clash-party/clash-party-up

git status -sb
git diff > local-changes-before-update.patch
git ls-files --others --exclude-standard > untracked-files-before-update.txt

git switch -c backup/custom-before-update-20260429
git add -A
git commit -m "wip: save local custom changes before upstream update"
git push -u origin backup/custom-before-update-20260429

git switch custom
git merge backup/custom-before-update-20260429

git switch -c update/upstream-smart-core-20260429
git fetch upstream
git log --oneline --left-right --graph HEAD...upstream/smart_core
git merge upstream/smart_core
```

如果没有冲突：

```bash
pnpm install
pnpm run typecheck
pnpm run lint:check
pnpm run build:win

git status -sb
git add -A
git commit -m "fix: resolve issues after upstream update"

git switch custom
git merge update/upstream-smart-core-20260429
git push origin custom
```

如果有冲突：

```bash
git status -sb
git diff --name-only --diff-filter=U
```

手动解决冲突后：

```bash
git add -A
git commit -m "merge upstream smart_core into custom update branch"

pnpm install
pnpm run typecheck
pnpm run lint:check
pnpm run build:win

git status -sb
git add -A
git commit -m "fix: resolve issues after upstream update"

git switch custom
git merge update/upstream-smart-core-20260429
git push origin custom
```

## 22. 最终确认清单

更新完成前，确认以下事项：

```text
[ ] 当前分支 custom 已经包含 upstream 新代码。
[ ] 自己新增的功能还在。
[ ] git status -sb 显示工作区干净。
[ ] pnpm install 执行成功。
[ ] pnpm run typecheck 执行成功。
[ ] pnpm run lint:check 执行成功。
[ ] pnpm run build:win 执行成功。
[ ] custom 已经 git push origin custom。
[ ] backup/custom-before-update-日期 分支仍然保留。
```


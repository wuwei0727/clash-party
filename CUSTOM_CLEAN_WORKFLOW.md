# custom-clean 简明操作

后续只在这个分支开发：

```bash
git switch custom-clean
```

## 1. 日常开发提交

```bash
git switch custom-clean
git status -sb
git add -A
git commit -m "你的提交说明"
git push
```

## 2. 更新远程 upstream 代码

原项目有新代码时，执行：

```bash
git switch custom-clean
git fetch upstream
git rebase upstream/smart_core
pnpm install
pnpm run typecheck
pnpm run lint:check
git push --force-with-lease
```

这套流程会把你的自定义功能重新叠加到 upstream 最新代码上。

已保留的自定义功能：

```text
日志级别筛选
日志暂停 / 继续
Profile 打开文件所在位置
Override 打开文件所在位置
```

## 3. 如果更新时有冲突

查看冲突：

```bash
git status -sb
git diff --name-only --diff-filter=U
```

手动改完冲突文件后：

```bash
git add 冲突文件
git rebase --continue
```

如果还有冲突，重复：

```bash
git add 冲突文件
git rebase --continue
```

如果不想继续这次更新：

```bash
git rebase --abort
```

## 4. 打包 Windows 安装包

```bash
git switch custom-clean
pnpm install
pnpm run build:win
```

安装包在：

```text
D:\cusor项目\clash-party\clash-party-up\dist\
```

常见文件名：

```text
clash-party-windows-版本号-x64-setup.exe
clash-party-windows-版本号-x64-portable.7z
```

## 5. 不要用

```bash
git pull
git merge upstream/smart_core
git reset --hard
git clean -fd
git push --force
```

日常只记住两组命令：

```bash
# 开发提交
git add -A
git commit -m "说明"
git push
```

```bash
# 更新 upstream
git fetch upstream
git rebase upstream/smart_core
git push --force-with-lease
```

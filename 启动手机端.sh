#!/system/bin/sh
# =====================================================================
# 启动手机端.sh —— 在手机上把客户端跑起来（Android / Termux 用）
#
# 为什么不用「启动客户端.bat」：那个是 Windows 的 cmd 脚本，手机上不认。
# 手机上要自己起服务器，得先装一个终端 App（Termux），装完用这条命令跑本文件：
#
#     sh /sdcard/Documents/DLnotebook/启动手机端.sh
#
# 跑起来后**别关 Termux**（关掉服务器就停了），然后浏览器打开：
#     http://127.0.0.1:8080
#
# 注意：/sdcard 是"不能直接执行"的分区，所以要用 `sh 脚本名` 调用，
# 不能 `./启动手机端.sh`（会报 Permission denied）。
# =====================================================================
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  这台手机还没有 node。"
  echo "  在 Termux 里先装一次：  pkg install -y nodejs"
  echo "  装完再跑一次本脚本。"
  echo ""
  exit 1
fi

echo ""
echo "  DLnotebook —— 正在启动本地服务器"
echo "  启动后用浏览器打开： http://127.0.0.1:8080"
echo "  这个窗口别关（关掉服务器就停了）。"
echo ""

# exec：让 node 直接接管这个进程，Ctrl+C / 关窗口时才不会留下孤儿进程
exec node tools/dev-server.js 8080

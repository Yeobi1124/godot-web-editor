extends SceneTree
## GitHub Actions 등 명령줄용:
##   godot --headless --path <프로젝트> -s res://<이 폴더>/cli.gd -- test [필터]
##   godot --headless --path <프로젝트> -s res://<이 폴더>/cli.gd -- check

const Runner := preload("gwe_runner.gd")


func _initialize() -> void:
	# _initialize 시점에는 루트가 아직 트리에 없어 _ready/@onready가 돌지 않는다. 첫 프레임에서 시작
	process_frame.connect(_run, CONNECT_ONE_SHOT)


func _run() -> void:
	var args := OS.get_cmdline_user_args()
	var mode: String = args[0] if args.size() > 0 else "test"
	var filter: String = args[1] if args.size() > 1 else ""
	var runner: Node = Runner.new()
	root.add_child(runner)
	var code: int = Runner.report(runner.run(mode, filter))
	runner.queue_free()
	quit(code)

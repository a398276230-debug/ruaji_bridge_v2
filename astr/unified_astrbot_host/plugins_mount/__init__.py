"""plugins_mount —— 三个插件的挂载点。

这里**不复制插件源码**。三个插件合起来 6 万多行，复制一份就等于分叉：
上游修 bug 之后，宿主里的这份不会跟着变，而"哪份是对的"没人说得清。
所以挂载 = 把插件目录的父路径加进 sys.path，然后按包名 import。

挂载顺序是有意义的，见 loader.MOUNT_ORDER 的注释。
"""

from .loader import MOUNT_ORDER, MountSpec, PluginMount, load_conf_defaults, mount_all

__all__ = [
    "MOUNT_ORDER",
    "MountSpec",
    "PluginMount",
    "load_conf_defaults",
    "mount_all",
]

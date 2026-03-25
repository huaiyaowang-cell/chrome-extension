插件名称：游戏通用下载器，支持下载crazygames、poki、minigame等平台上的游戏

插件输入：
1： 平台类型：下拉类型，可选项有crazygames、poki、minigame（必填）
2： 游戏url地址：游戏的url如：https://oneline.game-files.crazygames.com/oneline/12/index.html（必填）
3： 监听的url地址：需要监听的url（可选），如果不填默认为游戏地址的url地址，如https://oneline.game-files.crazygames.com/oneline/12，注意是去掉html剩下的，需要监听的url可以设置多个，点击添加监听url可添加需要监听的url地址
4: 下载目录：该游戏需要下载的目录（必填）
5： 游戏名称：游戏的名称（必填），文件会下载到下载目录下的游戏名称目录下

包含按钮和功能：
1： 开始监听：点击开始监听，插件会监听当前tab下所有来自监听url地址的文件，按照相对于游戏地址的路径保存到对应游戏下，比如，游戏地址为https://oneline.game-files.crazygames.com/oneline/12/index.html，下载目录为A，游戏名称为B，下载的文件url为https://oneline.game-files.crazygames.com/oneline/12/assets/modelsglb/char5/scene.glb，则该文件保存到相对于A目录下的B/assets/modelsglb/char5/scene.glb位置，如果不是来自游戏地址，该文件都保存到根目录，开始监听后文件都自动下载
2： 保存配置：点击保存配置，关闭插件重新打开配置不消失
3： 生成HTML，点击生成index.html,注意要根据所选的平台类型插入对应的桩函数和请求拦截代码，确保游戏下载到本地能运行，目前支持crazygames、poki、minigame，crazygames你需要参考网上资料或者https://sdk.crazygames.com/crazygames-sdk-v3.js这个地址的内容写个补丁，确保游戏能在本地加载，poki、minigame已经有了，在download-poki-game、download-mini-game这两个专门平台的插件中
4： 写入清单：在游戏根目录写入已下载清单
5： 附加资源下载功能，参考download-mini-game这个插件


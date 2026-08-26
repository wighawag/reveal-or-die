import {Assets, Container, Sprite, Texture} from 'pixi.js';

export class LoadingSprite extends Container {
	// graphics: Graphics | undefined;
	constructor(url: string) {
		super();

		// this.graphics = new Graphics().rect(0, 0, 1, 1).fill(0x00ff00);
		// this.addChild(this.graphics);

		const self = this;

		Assets.add({
			alias: url,
			src: url,
			data: {
				scaleMode: 'nearest',
			},
		});
		Assets.load(url)
			.then((t) => self.onLoaded(t))
			.catch((err) => {
				console.error(err);
			});
	}

	onLoaded(texture: Texture) {
		// if (this.graphics) {
		// 	this.removeChild(this.graphics);
		// 	this.graphics = undefined;
		// }

		const sprite = new Sprite(texture);
		this.addChild(sprite);
	}
}

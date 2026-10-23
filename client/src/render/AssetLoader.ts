import * as THREE from 'three';
import { GLTFLoader, GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

export type ModelKey =
  | 'knight'
  | 'barbarian'
  | 'floor_tile_large'
  | 'floor_tile_small_decorated'
  | 'floor_foundation_allsides'
  | 'pillar_decorated'
  | 'column'
  | 'torch_lit'
  | 'sword_shield_gold'
  | 'barrier_column';

const MODEL_PATHS: Record<ModelKey, string> = {
  knight: '/assets/models/knight.glb',
  barbarian: '/assets/models/barbarian.glb',
  floor_tile_large: '/assets/models/floor_tile_large.glb',
  floor_tile_small_decorated: '/assets/models/floor_tile_small_decorated.glb',
  floor_foundation_allsides: '/assets/models/floor_foundation_allsides.glb',
  pillar_decorated: '/assets/models/pillar_decorated.glb',
  column: '/assets/models/column.glb',
  torch_lit: '/assets/models/torch_lit.glb',
  sword_shield_gold: '/assets/models/sword_shield_gold.glb',
  barrier_column: '/assets/models/barrier_column.glb',
};

export class AssetLoader {
  private loader = new GLTFLoader();
  private cache = new Map<ModelKey, GLTF>();
  private riftBladeTemplate: THREE.Object3D | null = null;
  private isLoaded = false;

  public async loadAll(
    onProgress?: (loadedCount: number, totalCount: number, percent: number, label: string) => void
  ): Promise<void> {
    if (this.isLoaded) {
      onProgress?.(10, 10, 100, 'Hoàn tất tải tài nguyên 3D');
      return;
    }

    const keys = Object.keys(MODEL_PATHS) as ModelKey[];
    const total = keys.length;
    let loaded = 0;

    for (const key of keys) {
      const url = MODEL_PATHS[key];
      onProgress?.(loaded, total, Math.round((loaded / total) * 100), `Đang tải ${key}.glb...`);
      const gltf = await this.loadSingleWithRetry(url, 2);
      this.cache.set(key, gltf);
      loaded++;
      onProgress?.(loaded, total, Math.round((loaded / total) * 100), `Đã tải ${key}.glb`);
    }

    this.extractRiftBladeTemplate();
    this.isLoaded = true;
  }

  private loadSingleWithRetry(url: string, retriesLeft: number): Promise<GLTF> {
    return new Promise((resolve, reject) => {
      this.loader.load(
        url,
        (gltf) => resolve(gltf),
        undefined,
        (err) => {
          if (retriesLeft > 0) {
            setTimeout(() => {
              this.loadSingleWithRetry(url, retriesLeft - 1)
                .then(resolve)
                .catch(reject);
            }, 350);
          } else {
            reject(new Error(`Không thể tải model 3D tại ${url}: ${String(err)}`));
          }
        }
      );
    });
  }

  public getGLTF(key: ModelKey): GLTF {
    const found = this.cache.get(key);
    if (!found) {
      throw new Error(`Model ${key} chưa được tải.`);
    }
    return found;
  }

  private extractRiftBladeTemplate(): void {
    const knightGltf = this.cache.get('knight');
    if (knightGltf) {
      const swordNode =
        knightGltf.scene.getObjectByName('2H_Sword') ||
        knightGltf.scene.getObjectByName('1H_Sword');
      if (swordNode) {
        const cloned = swordNode.clone(true);
        cloned.position.set(0, 0, 0);
        cloned.rotation.set(0, 0, 0);
        cloned.scale.set(1.15, 1.15, 1.15);
        this.riftBladeTemplate = cloned;
        return;
      }
    }
    const relicGltf = this.cache.get('sword_shield_gold');
    if (relicGltf) {
      this.riftBladeTemplate = relicGltf.scene.clone(true);
    }
  }

  public createRiftBladeInstance(glowColorHex = 0x00f0ff): THREE.Group {
    const wrapper = new THREE.Group();
    if (this.riftBladeTemplate) {
      const meshClone = this.riftBladeTemplate.clone(true);
      meshClone.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const m = child as THREE.Mesh;
          m.castShadow = true;
          const cloneMat = (orig: THREE.Material): THREE.Material => {
            const mat = orig.clone() as THREE.MeshStandardMaterial;
            if ('emissive' in mat && mat.emissive) {
              mat.emissive = new THREE.Color(glowColorHex);
              mat.emissiveIntensity = 0.35;
              mat.roughness = 0.3;
              mat.metalness = 0.6;
            }
            return mat;
          };
          if (Array.isArray(m.material)) {
            m.material = m.material.map(cloneMat);
          } else if (m.material) {
            m.material = cloneMat(m.material);
          }
        }
      });
      wrapper.add(meshClone);
    }

    // Add subtle energy core blade aura
    const auraGeo = new THREE.BoxGeometry(0.12, 1.35, 0.04);
    const auraMat = new THREE.MeshBasicMaterial({
      color: glowColorHex,
      transparent: true,
      opacity: 0.45,
    });
    const aura = new THREE.Mesh(auraGeo, auraMat);
    aura.position.set(0, 0.65, 0);
    wrapper.add(aura);

    return wrapper;
  }
}

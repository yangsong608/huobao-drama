import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEED = ROOT / 'seed' / 'swap'


class SwapSeedTest(unittest.TestCase):
    def test_manifest_and_graphs_are_api_format_with_valid_targets(self):
        manifest = json.loads((SEED / 'manifest.json').read_text())
        workflows = {item['slug']: item for item in manifest['workflows']}
        self.assertEqual(set(workflows), {'h3-face-swap', 'h3-recast', 'h3-recast-relay'})
        for slug, item in workflows.items():
            graph = json.loads((SEED / item['file']).read_text())
            self.assertIn(item['output_node'], graph, slug)
            self.assertTrue(item['output_exts'], slug)
            for node_id, node in graph.items():
                for name, value in node['inputs'].items():
                    if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str):
                        self.assertIn(value[0], graph, f'{slug}:{node_id}.{name}')
            for name, spec in item['input_map'].items():
                targets = spec.get('targets') or [spec]
                for target in targets:
                    self.assertIn(str(target['node']), graph, f'{slug}:{name}')
                    self.assertIn(target['input'], graph[str(target['node'])]['inputs'], f'{slug}:{name}')

    def test_face_workflow_is_native_reference_video_stack(self):
        graph = json.loads((SEED / 'h3-face-swap.json').read_text())
        self.assertEqual(graph['conditioning']['class_type'], 'MiniMaxH3ReferenceToVideo')
        conditioning = graph['conditioning']['inputs']
        self.assertEqual(conditioning['ref_videos.ref_video_0'], ['frames', 0])
        self.assertEqual(conditioning['ref_images.ref_image_0'], ['reference', 0])
        self.assertEqual(conditioning['ref_image_size'], 'match')
        self.assertEqual(conditioning['length'], ['length_frames', 1])
        self.assertIn('<Video 1>', conditioning['prompt'])
        self.assertIn('<Picture 1>', conditioning['prompt'])
        self.assertEqual(graph['faceswap']['inputs']['lora_name'], 'MiniMaxH3/SS_FaceSwap/SS_FaceSwap_MiniMax_H3_REF2VA.safetensors')
        self.assertEqual(graph['faceswap']['inputs']['strength_model'], 1.3)
        self.assertEqual(graph['faceswap']['inputs']['model'], ['model', 0])
        self.assertNotIn('turbo', graph)
        self.assertEqual(graph['guider']['inputs']['model'], ['faceswap', 0])
        self.assertEqual(graph['schedule']['inputs']['model'], ['faceswap', 0])
        self.assertEqual(graph['sample']['inputs']['latent_image'], ['conditioning', 1])
        self.assertEqual(graph['schedule']['inputs']['steps'], 20)
        self.assertIn('subject_definitions', conditioning['prompt'])
        self.assertIn('retention_analysis', conditioning['prompt'])
        self.assertIn('IS <Subject 1>', conditioning['prompt'])
        self.assertIn("Nothing of <Subject 2>'s original face or hair remains", conditioning['prompt'])
        manifest = json.loads((SEED / 'manifest.json').read_text())
        face = next(item for item in manifest['workflows'] if item['slug'] == 'h3-face-swap')
        self.assertIn('subject_definitions', face['example']['prompt'])
        self.assertEqual(face['input_map']['source_video']['node'], 'source')
        self.assertEqual(face['input_map']['reference_face_1']['node'], 'reference')
        self.assertEqual(face['input_map']['duration_seconds']['node'], 'duration_seconds')
        self.assertEqual(face['input_map']['prompt']['node'], 'conditioning')
        self.assertEqual(face['input_map']['seed']['node'], 'noise')
        self.assertNotIn('continuity_reference', face['input_map'])
        self.assertEqual(face['output_node'], 'save')
        self.assertIn(face['output_node'], graph)

    def test_recast_workflow_has_expression_and_reference_size(self):
        graph = json.loads((SEED / 'h3-recast.json').read_text())
        self.assertTrue(graph['131']['inputs']['expression'])
        self.assertEqual(graph['136']['inputs']['ref_image_size'], 'match')
        self.assertEqual(graph['92']['inputs']['format'], 'auto')
        self.assertEqual(graph['147']['inputs']['lora_name'], 'h3_character_swap_v1.5.safetensors')

    def test_relay_workflow_is_windowed_character_swap_with_external_inputs(self):
        manifest = json.loads((SEED / 'manifest.json').read_text())
        item = next(entry for entry in manifest['workflows'] if entry['slug'] == 'h3-recast-relay')
        graph = json.loads((SEED / item['file']).read_text())
        self.assertEqual(item['output_node'], 'save')
        self.assertEqual(item['output_key'], 'images')
        self.assertEqual(item['output_exts'], ['mp4'])
        self.assertEqual(graph['source']['class_type'], 'LoadVideo')
        self.assertEqual(graph['reference']['class_type'], 'LoadImage')
        self.assertEqual(graph['prepare']['inputs']['resolution'], '480')
        self.assertLessEqual(graph['sampling_memory']['inputs']['activation_memory_gib'], 10.0)
        self.assertEqual(graph['plan']['inputs']['history_frames'], '1')
        self.assertEqual(graph['window']['inputs']['anchor'], ['reference', 0])
        self.assertTrue(graph['history']['inputs']['first_frame_guide'])
        self.assertEqual(graph['reference_conditioning']['inputs']['ref_images.ref_image_1'], ['window', 11])
        self.assertEqual(graph['plan']['class_type'], 'H3RelayWindowPlan')
        self.assertEqual(graph['reference_conditioning']['class_type'], 'MiniMaxH3ReferenceToVideo')
        self.assertEqual(graph['turbo']['inputs']['lora_name'], 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors')
        self.assertEqual(graph['adapter']['inputs']['lora_name'], 'h3_character_swap_v1.5.safetensors')
        self.assertEqual(graph['sam']['inputs']['ckpt_name'], 'sam3.1_multiplex_fp16.safetensors')
        self.assertNotIn('mask_preview', graph)
        self.assertEqual(item['input_map']['source_video']['node'], 'source')
        self.assertEqual(item['input_map']['scene_reference']['node'], 'reference')
        self.assertEqual(item['input_map']['reference_face_1']['node'], 'reference')
        self.assertEqual(item['input_map']['prompt']['node'], 'reference_conditioning')
        self.assertEqual(item['input_map']['seed']['node'], 'plan')


if __name__ == '__main__':
    unittest.main()

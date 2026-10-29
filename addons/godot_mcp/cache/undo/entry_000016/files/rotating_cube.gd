extends MeshInstance3D
## Slowly rotates the cube around the Y axis.

func _process(delta: float) -> void:
	rotate_y(deg_to_rad(30.0) * delta)

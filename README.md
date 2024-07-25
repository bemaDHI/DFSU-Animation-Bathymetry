Small demonstration of animating DFSU files by sending both the DFSU's mesh vertices and timestep values.
Note this technique (in it's current form) is only suitable for smaller DFSU files without too many timesteps.
Allows for updating any legend scales on the fly.

1. Copy your DFSU file into the data folder.
2. Update the file referenced in the DfsuController.
3. Update the legendColorRange variable in the 1_Animation.js, 2_Animation_Comparison.js and 3_Bathymetry.js files to something that matches the values contained within the file.
4. Running the project should bring up the 1_Animation.html page.

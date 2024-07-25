using DHI.Generic.MikeZero.DFS.dfsu;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using ProjNet.CoordinateSystems.Transformations;
using ProjNet.CoordinateSystems;
using System.IO.Compression;

namespace DFSUAnimationDemo.Controllers
{
    [Route("api/[controller]")]
    [ApiController]
    public class DfsuController : ControllerBase
    {
        private readonly string filePath = "./Data/TN2013_12hr_DA_mgL.dfsu";
        //private readonly string filePath = "./Data/TN_2013_Percentiles_25.dfsu";
        private static byte[]? verticesBuffer = null;
        private static byte[]? allTimestepBuffer = null;

        [HttpGet("vertices-buffer")]
        public ActionResult GetVerticesBuffer()
        {
            if (verticesBuffer == null)
            {
                using IDfsuFile file = DfsuFile.Open(filePath);

                var csFact = new CoordinateSystemFactory();
                var ctFact = new CoordinateTransformationFactory();
                var srcCs = csFact.CreateFromWkt(file.Projection.WKTString);
                var trans = ctFact.CreateFromCoordinateSystems(srcCs, GeographicCoordinateSystem.WGS84);

                var nodeIdToIndex = new Dictionary<int, uint>();
                for (uint i = 0; i < file.NodeIds.Length; ++i)
                {
                    nodeIdToIndex[file.NodeIds[i]] = i;
                }

                // Need to insert extra triangles for quads.
                var quads = file.ElementTable.Where(elem => elem.Length > 3).ToList();

                float[] vertices = new float[file.ElementIds.Length * 3 * 3 + quads.Count * 3 * 3];

                int j = 0;
                for (int i = 0; i < file.ElementTable.GetLength(0); ++i)
                {
                    var v1Index = nodeIdToIndex[file.ElementTable[i][0]];
                    var v2Index = nodeIdToIndex[file.ElementTable[i][1]];
                    var v3Index = nodeIdToIndex[file.ElementTable[i][2]];

                    var vertex1Projected = trans.MathTransform.Transform(file.X[v1Index], file.Y[v1Index]);
                    var vertex2Projected = trans.MathTransform.Transform(file.X[v2Index], file.Y[v2Index]);
                    var vertex3Projected = trans.MathTransform.Transform(file.X[v3Index], file.Y[v3Index]);

                    vertices[j++] = (float)vertex1Projected.x;
                    vertices[j++] = (float)vertex1Projected.y;
                    vertices[j++] = file.Z[v1Index];

                    vertices[j++] = (float)vertex2Projected.x;
                    vertices[j++] = (float)vertex2Projected.y;
                    vertices[j++] = file.Z[v2Index];

                    vertices[j++] = (float)vertex3Projected.x;
                    vertices[j++] = (float)vertex3Projected.y;
                    vertices[j++] = file.Z[v3Index];

                    if (file.ElementTable[i].Length == 4)
                    {
                        var v4Index = nodeIdToIndex[file.ElementTable[i][3]];
                        var vertex4Projected = trans.MathTransform.Transform(file.X[v4Index], file.Y[v4Index]);

                        vertices[j++] = (float)vertex1Projected.x;
                        vertices[j++] = (float)vertex1Projected.y;
                        vertices[j++] = file.Z[v1Index];

                        vertices[j++] = (float)vertex3Projected.x;
                        vertices[j++] = (float)vertex3Projected.y;
                        vertices[j++] = file.Z[v3Index];

                        vertices[j++] = (float)vertex4Projected.x;
                        vertices[j++] = (float)vertex4Projected.y;
                        vertices[j++] = file.Z[v4Index];
                    }
                }

                var byteArray = new byte[vertices.Length * 4];
                Buffer.BlockCopy(vertices, 0, byteArray, 0, byteArray.Length);

                // Convert to GZipped file to reduce network transfer size.
                verticesBuffer = _GZipBuffer(byteArray);
            }

            GC.Collect();

            Response.Headers["Content-Encoding"] = "gzip";
            return File(verticesBuffer, "application/octet-stream", "vertices-buffer.bin");
        }

        [HttpGet("timestep-buffer")]
        public ActionResult GetAllTimestepsBuffer(int itemNumber = 1)
        {
            if (allTimestepBuffer == null)
            {
                using IDfsuFile file = DfsuFile.Open(filePath);

                var dfsInfo = GetDfsInfo(itemNumber);

                int allTimestepsCount = dfsInfo.TriangleCount * file.NumberOfTimeSteps;
                float[] allTimesteps = new float[allTimestepsCount];
                float[] values = new float[dfsInfo.TriangleCount];
                float[] valuesExcludingQuads;

                for (int t = 0; t < file.NumberOfTimeSteps; ++t)
                {
                    valuesExcludingQuads = (float[])file.ReadItemTimeStep(itemNumber, t).Data;

                    int j = 0;
                    for (int i = 0; i < file.ElementTable.GetLength(0); ++i)
                    {
                        var value = valuesExcludingQuads[i];
                        if (value == file.DeleteValueFloat)
                        {
                            value = -999.9f;
                        }

                        values[j++] = value;

                        // Add duplicate value for extra triangle.
                        if (file.ElementTable[i].Length == 4)
                        {
                            values[j++] = value;
                        }
                    }

                    values.CopyTo(allTimesteps, t * dfsInfo.TriangleCount);
                }

                _CompressTimestep(allTimesteps, 2);

                // Convert to GZipped file to reduce network transfer size.
                var byteArray = new byte[allTimesteps.Length * 4];
                Buffer.BlockCopy(allTimesteps, 0, byteArray, 0, byteArray.Length);
                allTimestepBuffer = _GZipBuffer(byteArray);
            }

            GC.Collect();

            Response.Headers["Content-Encoding"] = "gzip";
            return File(allTimestepBuffer, "application/octet-stream", $"timestep-buffer-{itemNumber}-all.bin");
        }

        [HttpGet("dfs-info")]
        public DfsInfo GetDfsInfo(int itemNumber = 1)
        {
            using IDfsuFile file = DfsuFile.Open(filePath);

            float[] valuesExcludingQuads = (float[])file.ReadItemTimeStep(itemNumber, 0).Data;
            var quadsCount = file.ElementTable.Where(elem => elem.Length > 3).Count();
            int triangleCount = valuesExcludingQuads.Length + quadsCount;

            var info = new DfsInfo
            {
                TimeStepCount = file.NumberOfTimeSteps,
                TriangleCount = triangleCount
            };
            return info;
        }

        // Applies a very basic compression to the timestep data by limiting the number of significant digits and
        // decimal places of the timstep data.
        private static void _CompressTimestep(float[] timestep, int significantDigits)
        {
            for (int i = 0; i < timestep.Length; ++i)
            {
                timestep[i] = _RoundSignificantDigits(timestep[i], significantDigits);
            }
        }

        private static float _RoundSignificantDigits(float d, int digits)
        {
            if (d == 0)
                return 0;
            if (d == -999.9f)
                return d;

            float scale = MathF.Pow(10, MathF.Floor(MathF.Log10(MathF.Abs(d))) + 1);
            return scale * MathF.Round(d / scale, digits);
        }

        private static byte[] _GZipBuffer(byte[] buffer)
        {
            using var memoryStream = new MemoryStream();
            using var gzipStream = new GZipStream(memoryStream, CompressionMode.Compress);
            gzipStream.Write(buffer, 0, buffer.Length);
            gzipStream.Close();
            return memoryStream.ToArray();
        }
    }
}
